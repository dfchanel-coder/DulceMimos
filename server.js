// server.js

// 1. Importar módulos necesarios
const express = require('express');
const cors = require('cors');
const path = require('path'); // Agregado para manejar rutas de archivos si fuera necesario

// --- IMPORTAR MERCADO PAGO ---
const { MercadoPagoConfig, Preference } = require('mercadopago');

// --- CONFIGURAR CLIENTE DE MERCADO PAGO ---
const client = new MercadoPagoConfig({ accessToken: 'APP_USR-5744010610153975-072300-19bf495e168ddc1350b6f8a5397f24a5-36478890' });

// 2. Crear una instancia de la aplicación Express
const app = express();

// 3. Usar Middlewares ESENCIALES
app.use(cors());
app.use(express.json());

// 4. Definir el puerto
const PUERTO = 3000;

// --- IMPORTAR MODELOS Y CONFIGURACIÓN DE SEQUELIZE ---
const db = require('./models'); 
const { Celular, Orden, OrderItem, sequelize } = db; 

// ==========================================
// RUTAS API PARA CELULARES (CRUD)
// ==========================================

app.post('/api/celulares', async (req, res) => {
    console.log("SERVER.JS: Recibida solicitud POST /api/celulares", req.body);
    try {
        const nuevoCelularData = req.body;
        if (!nuevoCelularData.modelo || !nuevoCelularData.marca || nuevoCelularData.precio === undefined || nuevoCelularData.stock === undefined) {
          return res.status(400).json({ mensaje: "Error: Faltan datos obligatorios." });
        }
        const celularCreado = await Celular.create(nuevoCelularData);
        res.status(201).json({ mensaje: "Celular creado exitosamente", data: celularCreado });
    } catch (error) {
        console.error("SERVER.JS: Error en POST /api/celulares:", error);
        res.status(500).json({ mensaje: "Error interno del servidor." });
    }
});

app.get('/api/celulares', async (req, res) => {
    try {
        const todosLosCelulares = await Celular.findAll({order: [['createdAt', 'DESC']]}); 
        res.json({ mensaje: "Lista de celulares obtenida", data: todosLosCelulares });
    } catch (error) {
        console.error("SERVER.JS: Error en GET /api/celulares:", error);
        res.status(500).json({ mensaje: "Error interno del servidor." });
    }
});

app.get('/api/celulares/:id', async (req, res) => {
    try {
        const idCelular = parseInt(req.params.id);
        if (isNaN(idCelular)) return res.status(400).json({ mensaje: "ID inválido."});
        const celular = await Celular.findByPk(idCelular); 
        if (celular) res.json({ mensaje: "Celular encontrado", data: celular });
        else res.status(404).json({ mensaje: "Celular no encontrado." });
    } catch (error) {
        res.status(500).json({ mensaje: "Error interno del servidor." });
    }
});

app.put('/api/celulares/:id', async (req, res) => {
    try {
        const idCelular = parseInt(req.params.id);
        const celular = await Celular.findByPk(idCelular); 
        if (!celular) return res.status(404).json({ mensaje: "Celular no encontrado." });
        
        const celularActualizado = await celular.update(req.body);
        res.json({ mensaje: "Celular actualizado", data: celularActualizado });
    } catch (error) {
        console.error(`Error PUT:`, error);
        res.status(500).json({ mensaje: "Error interno." });
    }
});

app.delete('/api/celulares/:id', async (req, res) => {
    try {
        const idCelular = parseInt(req.params.id);
        const celular = await Celular.findByPk(idCelular); 
        if (!celular) return res.status(404).json({ mensaje: "Celular no encontrado." });

        await celular.destroy();
        res.json({ mensaje: "Celular eliminado", data_eliminada: celular });
    } catch (error) {
        res.status(500).json({ mensaje: "Error interno." });
    }
});

// ==========================================================
// RUTAS API PARA ÓRDENES (CON INTEGRACIÓN MERCADO PAGO)
// ==========================================================

app.post('/api/ordenes', async (req, res) => {
    console.log("SERVER.JS: Recibida solicitud POST /api/ordenes:", req.body);
    const t = await sequelize.transaction(); 
    try {
        const { clienteInfo, items } = req.body;
        
        if (!clienteInfo || !clienteInfo.nombre || !items || items.length === 0) {
            await t.rollback();
            return res.status(400).json({ mensaje: "Datos incompletos para crear la orden." });
        }

        let montoTotalCalculado = 0;
        const productosParaActualizarStockEItems = [];
        const itemsMercadoPago = [];

        // 1. Verificar stock y preparar items
        for (const item of items) {
            const celularDB = await Celular.findByPk(item.id, { transaction: t, lock: t.LOCK.UPDATE });
            
            if (!celularDB) throw new Error(`Producto ID ${item.id} no encontrado.`);
            if (celularDB.stock < item.cantidad) throw new Error(`Stock insuficiente para ${celularDB.modelo}.`);
            
            montoTotalCalculado += celularDB.precio * item.cantidad;
            
            productosParaActualizarStockEItems.push({ 
                celularDB, 
                cantidadComprada: item.cantidad, 
                precioUnitarioCompra: celularDB.precio 
            });

            // PREPARAMOS ITEM PARA MERCADO PAGO CON 10% RECARGO
            const precioConRecargo = Number((celularDB.precio * 1.10).toFixed(2));
            
            itemsMercadoPago.push({
                title: `${celularDB.marca} ${celularDB.modelo}`,
                quantity: Number(item.cantidad),
                currency_id: 'UYU', 
                unit_price: precioConRecargo
            });
        }

        // 2. Crear Orden Local
        const nuevaOrden = await Orden.create({
            clienteNombre: clienteInfo.nombre,
            clienteEmail: clienteInfo.email,
            clienteDireccion: clienteInfo.direccion,
            clienteWhatsapp: clienteInfo.whatsapp,
            totalPedido: montoTotalCalculado,
            estado: 'Pendiente',
        }, { transaction: t });

        // 3. Guardar Items y Restar Stock
        for (const info of productosParaActualizarStockEItems) {
            await OrderItem.create({
                ordenId: nuevaOrden.id, 
                celularId: info.celularDB.id,
                cantidad: info.cantidadComprada, 
                precioUnitario: info.precioUnitarioCompra,
            }, { transaction: t });
            
            info.celularDB.stock -= info.cantidadComprada;
            await info.celularDB.save({ transaction: t });
        }

        // 4. GENERAR PREFERENCIA DE MERCADO PAGO
        let preferenceResult = null;
        try {
            console.log("SERVER: Intentando conectar con Mercado Pago...");
            const preference = new Preference(client);
            
            preferenceResult = await preference.create({
                body: {
                    items: itemsMercadoPago,
                    payer: {
                        name: clienteInfo.nombre,
                        email: clienteInfo.email,
                        phone: { number: clienteInfo.whatsapp } // Opcional, ayuda a MP
                    },
                    back_urls: {
                        success: "http://localhost:3000/success",
                        failure: "http://localhost:3000/failure",
                        pending: "http://localhost:3000/pending"
                    },
                    // --- CORRECCIÓN: ELIMINAMOS auto_return PARA EVITAR ERROR ---
                    // auto_return: "approved", 
                    external_reference: nuevaOrden.id.toString(),
                    statement_descriptor: "DULCE MIMOS"
                }
            });
            console.log("SERVER.JS: Preferencia MP creada con éxito, ID:", preferenceResult.id);
        } catch (mpError) {
            console.error("SERVER.JS: ERROR CRÍTICO MERCADO PAGO:", mpError);
            // La orden se guarda, pero no habrá link.
        }

        await t.commit(); 
        
        console.log("SERVER.JS: Orden local creada exitosamente, ID:", nuevaOrden.id);
        
        res.status(201).json({ 
            mensaje: "Pedido realizado con éxito.", 
            ordenId: nuevaOrden.id, 
            orden: { totalPedido: montoTotalCalculado },
            mpInitPoint: preferenceResult ? preferenceResult.init_point : null 
        });

    } catch (error) {
        await t.rollback();
        console.error("SERVER.JS: Error en POST /api/ordenes:", error);
        res.status(400).json({ mensaje: error.message || "Error al procesar el pedido." });
    }
});

// Rutas GET y PUT de órdenes
app.get('/api/ordenes', async (req, res) => {
    try {
        const ordenes = await Orden.findAll({
            include: [{ model: OrderItem, as: 'items', include: [{ model: Celular, as: 'celular' }] }],
            order: [['createdAt', 'DESC']]
        });
        res.json({ mensaje: "Lista obtenida", data: ordenes });
    } catch (error) {
        res.status(500).json({ mensaje: "Error interno." });
    }
});

app.get('/api/ordenes/:id', async (req, res) => {
    try {
        const orden = await Orden.findByPk(req.params.id, {
            include: [{ model: OrderItem, as: 'items', include: [{ model: Celular, as: 'celular' }] }]
        });
        if (orden) res.json({ mensaje: "Orden encontrada", data: orden });
        else res.status(404).json({ mensaje: "No encontrada." });
    } catch (error) { res.status(500).json({ mensaje: "Error interno." }); }
});

app.put('/api/ordenes/:id', async (req, res) => {
    try {
        const orden = await Orden.findByPk(req.params.id);
        if (!orden) return res.status(404).json({ mensaje: "Orden no encontrada." });
        if (req.body.estado) orden.estado = req.body.estado;
        await orden.save();
        res.json({ mensaje: "Orden actualizada", data: orden });
    } catch (error) { res.status(500).json({ mensaje: "Error interno." }); }
});

// --- RUTAS DE RETORNO (Success/Failure) ---
// Estas páginas se mostrarán cuando el usuario vuelva de Mercado Pago
app.get('/success', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px; color: #2E7D32;">
            <h1>¡Pago Aprobado! 🎉</h1>
            <p>Gracias por tu compra en Dulce Mimos.</p>
            <a href="http://localhost:3000/index.html" style="background: #D87093; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Volver a la tienda</a>
        </div>
    `);
});

app.get('/failure', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px; color: #C62828;">
            <h1>El pago no se completó 😔</h1>
            <p>Hubo un problema con el pago.</p>
            <a href="http://localhost:3000/index.html" style="background: #D87093; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Volver e intentar de nuevo</a>
        </div>
    `);
});

app.get('/pending', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px; color: #EF6C00;">
            <h1>Pago Pendiente ⏳</h1>
            <p>Tu pago se está procesando.</p>
            <a href="http://localhost:3000/index.html" style="background: #D87093; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Volver a la tienda</a>
        </div>
    `);
});

// Servir archivos estáticos (HTML, CSS, JS, Imágenes)
// Esto permite que http://localhost:3000/index.html funcione correctamente
app.use(express.static(__dirname));


// --- INICIAR SERVIDOR ---
async function iniciarServidor() {
  try {
    await sequelize.sync({ alter: true });
    console.log('Base de datos sincronizada.');

    app.listen(PUERTO, () => {
      console.log(`\n¡Servidor escuchando en http://localhost:${PUERTO}!`);
      console.log('Integración Mercado Pago: ACTIVA (Sin auto-return)');
    });
  } catch (error) {
    console.error('No se pudo iniciar el servidor:', error);
  }
}

iniciarServidor();