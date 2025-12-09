require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const db = require('./models');
const { Celular, Orden, OrderItem, sequelize } = db;

// --- CONFIGURACIÓN ---
const app = express();
const PORT = process.env.PORT || 3000;
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// API CELULARES
// ==========================================

app.get('/api/celulares', async (req, res) => {
    try {
        const celulares = await Celular.findAll({ order: [['createdAt', 'DESC']] });
        res.json({ data: celulares });
    } catch (error) {
        res.status(500).json({ mensaje: "Error del servidor" });
    }
});

app.get('/api/celulares/:id', async (req, res) => {
    try {
        const celular = await Celular.findByPk(req.params.id);
        if (!celular) return res.status(404).json({ mensaje: "No encontrado" });
        res.json({ data: celular });
    } catch (error) {
        res.status(500).json({ mensaje: "Error del servidor" });
    }
});

app.post('/api/celulares', async (req, res) => {
    try {
        const { modelo, marca, precio, stock } = req.body;
        if (!modelo || !marca || precio === undefined || stock === undefined) {
            return res.status(400).json({ mensaje: "Faltan datos obligatorios" });
        }
        const nuevoCelular = await Celular.create(req.body);
        res.status(201).json({ mensaje: "Creado exitosamente", data: nuevoCelular });
    } catch (error) {
        console.error(error);
        res.status(500).json({ mensaje: "Error al crear celular" });
    }
});

app.put('/api/celulares/:id', async (req, res) => {
    try {
        const celular = await Celular.findByPk(req.params.id);
        if (!celular) return res.status(404).json({ mensaje: "No encontrado" });
        
        const actualizado = await celular.update(req.body);
        res.json({ mensaje: "Actualizado", data: actualizado });
    } catch (error) {
        res.status(500).json({ mensaje: "Error al actualizar" });
    }
});

app.delete('/api/celulares/:id', async (req, res) => {
    try {
        const celular = await Celular.findByPk(req.params.id);
        if (!celular) return res.status(404).json({ mensaje: "No encontrado" });

        await celular.destroy();
        res.json({ mensaje: "Eliminado", data_eliminada: celular });
    } catch (error) {
        res.status(500).json({ mensaje: "Error al eliminar" });
    }
});

// ==========================================
// API ÓRDENES & MERCADO PAGO
// ==========================================

app.get('/api/ordenes', async (req, res) => {
    try {
        const ordenes = await Orden.findAll({
            include: [{ model: OrderItem, as: 'items', include: [{ model: Celular, as: 'celular' }] }],
            order: [['createdAt', 'DESC']]
        });
        res.json({ data: ordenes });
    } catch (error) {
        res.status(500).json({ mensaje: "Error al obtener órdenes" });
    }
});

app.get('/api/ordenes/:id', async (req, res) => {
    try {
        const orden = await Orden.findByPk(req.params.id, {
            include: [{ model: OrderItem, as: 'items', include: [{ model: Celular, as: 'celular' }] }]
        });
        return orden ? res.json({ data: orden }) : res.status(404).json({ mensaje: "No encontrada" });
    } catch (error) {
        res.status(500).json({ mensaje: "Error interno" });
    }
});

app.put('/api/ordenes/:id', async (req, res) => {
    try {
        const orden = await Orden.findByPk(req.params.id);
        if (!orden) return res.status(404).json({ mensaje: "Orden no encontrada" });
        
        if (req.body.estado) {
            orden.estado = req.body.estado;
            await orden.save();
        }
        res.json({ mensaje: "Estado actualizado", data: orden });
    } catch (error) {
        res.status(500).json({ mensaje: "Error al actualizar orden" });
    }
});

app.post('/api/ordenes', async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const { clienteInfo, items } = req.body;

        if (!clienteInfo?.nombre || !items?.length) {
            await t.rollback();
            return res.status(400).json({ mensaje: "Datos incompletos" });
        }

        let total = 0;
        const itemsMP = [];
        
        // 1. Crear Orden
        const orden = await Orden.create({
            clienteNombre: clienteInfo.nombre,
            clienteEmail: clienteInfo.email,
            clienteDireccion: clienteInfo.direccion,
            clienteWhatsapp: clienteInfo.whatsapp,
            totalPedido: 0, // Se actualiza luego o se calcula al vuelo
            estado: 'Pendiente',
        }, { transaction: t });

        // 2. Procesar Items (Stock y MP)
        for (const item of items) {
            const prod = await Celular.findByPk(item.id, { transaction: t, lock: t.LOCK.UPDATE });
            
            if (!prod) throw new Error(`Producto ID ${item.id} no existe`);
            if (prod.stock < item.cantidad) throw new Error(`Stock insuficiente: ${prod.modelo}`);

            // Actualizar stock
            prod.stock -= item.cantidad;
            await prod.save({ transaction: t });

            // Guardar detalle
            await OrderItem.create({
                ordenId: orden.id,
                celularId: prod.id,
                cantidad: item.cantidad,
                precioUnitario: prod.precio
            }, { transaction: t });

            total += prod.precio * item.cantidad;

            // Item para Mercado Pago (con 10% recargo)
            itemsMP.push({
                title: `${prod.marca} ${prod.modelo}`,
                quantity: Number(item.cantidad),
                currency_id: 'UYU',
                unit_price: Number((prod.precio * 1.10).toFixed(2))
            });
        }

        // Actualizar total orden
        orden.totalPedido = total;
        await orden.save({ transaction: t });

        // 3. Generar Preferencia MP
        let mpInitPoint = null;
        try {
            const preference = new Preference(mpClient);
            const prefResult = await preference.create({
                body: {
                    items: itemsMP,
                    payer: {
                        name: clienteInfo.nombre,
                        email: clienteInfo.email,
                        phone: { number: clienteInfo.whatsapp }
                    },
                    back_urls: {
                        success: `http://localhost:${PORT}/success`,
                        failure: `http://localhost:${PORT}/failure`,
                        pending: `http://localhost:${PORT}/pending`
                    },
                    external_reference: orden.id.toString(),
                    statement_descriptor: "DULCE MIMOS"
                }
            });
            mpInitPoint = prefResult.init_point;
        } catch (mpError) {
            console.error("Error MercadoPago:", mpError);
            // No fallamos la transacción si falla MP, pero no devolvemos link
        }

        await t.commit();
        res.status(201).json({ mensaje: "Orden creada", ordenId: orden.id, orden, mpInitPoint });

    } catch (error) {
        await t.rollback();
        console.error("Error checkout:", error.message);
        res.status(400).json({ mensaje: error.message || "Error al procesar pedido" });
    }
});

// --- FEEDBACK PAGES ---
const feedbackTemplate = (color, title, msg) => `
    <div style="font-family:sans-serif;text-align:center;margin-top:50px;color:${color};">
        <h1>${title}</h1><p>${msg}</p>
        <a href="/" style="background:#D87093;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Volver</a>
    </div>`;

app.get('/success', (req, res) => res.send(feedbackTemplate('#2E7D32', '¡Pago Aprobado! 🎉', 'Gracias por tu compra.')));
app.get('/failure', (req, res) => res.send(feedbackTemplate('#C62828', 'Error en el pago 😔', 'Hubo un problema.')));
app.get('/pending', (req, res) => res.send(feedbackTemplate('#EF6C00', 'Pago Pendiente ⏳', 'Se está procesando.')));

// --- INICIO ---
(async () => {
    try {
        await sequelize.sync({ alter: true });
        app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
    } catch (e) {
        console.error('Error al iniciar:', e);
    }
})();
