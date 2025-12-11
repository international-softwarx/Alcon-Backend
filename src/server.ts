import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 🔥 Estructura mejorada para multi-PC
interface WindowsClient {
  socketId: string;
  clientId: string; // ID único del cliente
  socket: Socket;
  lastScreenshot: ScreenshotData | null;
  connectedAt: number;
  hostname?: string;
}

interface WebClient {
  socketId: string;
  socket: Socket;
  watchingClientId: string | null; // ID del Windows que está viendo
}

interface ScreenshotData {
  image: string;
  timestamp: number;
  clientId: string;
}

const windowsClients = new Map<string, WindowsClient>(); // Key: clientId único
const webClients = new Map<string, WebClient>(); // Key: socket.id

// ============================================
// ENDPOINTS HTTP
// ============================================

app.get('/ping', (req, res) => {
  res.json({ 
    status: 'online', 
    timestamp: new Date().toISOString(),
    windowsClients: windowsClients.size,
    webClients: webClients.size,
    environment: process.env.NODE_ENV || 'development'
  });
});

app.post('/update', (req, res) => {
  const { text, clientId } = req.body;
  
  if (!text && text !== 0) {
    return res.status(400).json({ error: 'Text required' });
  }
  
  // Si hay clientId, enviar solo a ese cliente
  if (clientId) {
    const client = windowsClients.get(clientId);
    if (client) {
      client.socket.emit('update_overlay', { text: String(text) });
      return res.json({ success: true, text, clientsNotified: 1 });
    }
    return res.status(404).json({ error: 'Client not found' });
  }
  
  // Si no hay clientId, enviar a todos (comportamiento legacy)
  windowsClients.forEach(client => {
    client.socket.emit('update_overlay', { text: String(text) });
  });
  
  res.json({ 
    success: true, 
    text,
    clientsNotified: windowsClients.size
  });
});

app.post('/toggle-overlay', (req, res) => {
  const { visible, clientId } = req.body;
  
  if (clientId) {
    const client = windowsClients.get(clientId);
    if (client) {
      client.socket.emit('toggle_overlay', { visible });
      return res.json({ success: true, visible });
    }
    return res.status(404).json({ error: 'Client not found' });
  }
  
  windowsClients.forEach(client => {
    client.socket.emit('toggle_overlay', { visible });
  });
  
  res.json({ success: true, visible });
});

app.get('/latest-screenshot', (req, res) => {
  const { clientId } = req.query;
  
  if (clientId) {
    const client = windowsClients.get(clientId as string);
    if (!client || !client.lastScreenshot) {
      return res.status(404).json({ error: 'No screenshot available' });
    }
    return res.json(client.lastScreenshot);
  }
  
  res.status(400).json({ error: 'clientId required' });
});

// 🔥 Nuevo endpoint: listar PCs conectadas
app.get('/connected-pcs', (req, res) => {
  const pcs = Array.from(windowsClients.values()).map(client => ({
    clientId: client.clientId,
    socketId: client.socketId,
    hostname: client.hostname || 'Unknown PC',
    connectedAt: client.connectedAt,
    hasScreenshot: !!client.lastScreenshot
  }));
  
  res.json({ pcs, count: pcs.length });
});

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
  console.log(`📱 Cliente conectado: ${socket.id}`);
  
  // Identificar tipo de cliente
  socket.on('client_type', (data) => {
    const type = data.type;
    
    if (type === 'windows') {
      const clientId = data.clientId || socket.id; // ID único del cliente
      const hostname = data.hostname || 'Unknown PC';
      
      const windowsClient: WindowsClient = {
        socketId: socket.id,
        clientId: clientId,
        socket: socket,
        lastScreenshot: null,
        connectedAt: Date.now(),
        hostname: hostname
      };
      
      windowsClients.set(clientId, windowsClient);
      console.log(`💻 Cliente Windows registrado: ${clientId} (${hostname})`);
      
      // Notificar a todos los clientes web sobre la nueva PC
      broadcastPCList();
      
    } else if (type === 'web') {
      const webClient: WebClient = {
        socketId: socket.id,
        socket: socket,
        watchingClientId: null
      };
      
      webClients.set(socket.id, webClient);
      console.log(`🌐 Cliente Web registrado: ${socket.id}`);
      
      // Enviar lista de PCs disponibles
      socket.emit('pc_list_update', {
        pcs: Array.from(windowsClients.values()).map(client => ({
          clientId: client.clientId,
          hostname: client.hostname,
          connectedAt: client.connectedAt,
          hasScreenshot: !!client.lastScreenshot
        }))
      });
    }
  });
  
  // 🔥 Cliente web selecciona qué PC ver
  socket.on('watch_pc', (data) => {
    const webClient = webClients.get(socket.id);
    if (!webClient) return;
    
    const { clientId } = data;
    webClient.watchingClientId = clientId;
    
    console.log(`👁️ Web ${socket.id} ahora ve a PC ${clientId}`);
    
    // Enviar screenshot más reciente si existe
    const windowsClient = windowsClients.get(clientId);
    if (windowsClient && windowsClient.lastScreenshot) {
      socket.emit('screen_update', windowsClient.lastScreenshot);
    }
  });
  
  // 🔥 Cliente web deja de ver una PC
  socket.on('unwatch_pc', () => {
    const webClient = webClients.get(socket.id);
    if (webClient) {
      webClient.watchingClientId = null;
      console.log(`👁️ Web ${socket.id} dejó de ver PC`);
    }
  });
  
  // Recibir screenshots desde Windows
  socket.on('screen_update', (data) => {
    // Buscar el cliente Windows por socketId
    let windowsClient: WindowsClient | undefined;
    
    for (const client of windowsClients.values()) {
      if (client.socketId === socket.id) {
        windowsClient = client;
        break;
      }
    }
    
    if (!windowsClient) return;
    
    const screenshot: ScreenshotData = {
      image: data.image,
      timestamp: data.timestamp,
      clientId: windowsClient.clientId
    };
    
    // Guardar screenshot
    windowsClient.lastScreenshot = screenshot;
    
    // Enviar solo a clientes web que están viendo esta PC
    webClients.forEach(webClient => {
      if (webClient.watchingClientId === windowsClient!.clientId) {
        webClient.socket.emit('screen_update', screenshot);
      }
    });
  });
  
  // Cliente web solicita screenshot de una PC específica
  socket.on('request_screenshot', (data) => {
    const { clientId } = data;
    
    if (clientId) {
      const windowsClient = windowsClients.get(clientId);
      if (windowsClient) {
        windowsClient.socket.emit('request_screenshot', {});
      }
    } else {
      // Legacy: solicitar a todos
      windowsClients.forEach(client => {
        client.socket.emit('request_screenshot', {});
      });
    }
  });
  
  // Control remoto (enviado a PC específica)
  socket.on('remote_command', (data) => {
    const { clientId, command } = data;
    
    if (clientId) {
      const windowsClient = windowsClients.get(clientId);
      if (windowsClient) {
        windowsClient.socket.emit('execute_command', { command });
      }
    } else {
      // Legacy: enviar a todos
      windowsClients.forEach(client => {
        client.socket.emit('execute_command', data);
      });
    }
  });
  
  // Desconexión
  socket.on('disconnect', () => {
    // Buscar y eliminar cliente Windows
    for (const [clientId, client] of windowsClients.entries()) {
      if (client.socketId === socket.id) {
        windowsClients.delete(clientId);
        console.log(`💻 Windows desconectado: ${clientId}`);
        broadcastPCList();
        break;
      }
    }
    
    // Eliminar cliente web
    if (webClients.has(socket.id)) {
      webClients.delete(socket.id);
      console.log(`🌐 Web desconectado: ${socket.id}`);
    }
  });
});

// 🔥 Función para notificar a todos los clientes web sobre cambios en la lista de PCs
function broadcastPCList() {
  const pcList = Array.from(windowsClients.values()).map(client => ({
    clientId: client.clientId,
    hostname: client.hostname,
    connectedAt: client.connectedAt,
    hasScreenshot: !!client.lastScreenshot
  }));
  
  webClients.forEach(webClient => {
    webClient.socket.emit('pc_list_update', { pcs: pcList });
  });
}

// ============================================
// SERVIDOR
// ============================================

httpServer.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  console.log(`🌐 Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Local: http://localhost:${PORT}`);
  console.log(`💻 Windows clients: ${windowsClients.size}`);
  console.log(`🌐 Web clients: ${webClients.size}`);
});

// Keep-alive
setInterval(() => {
  console.log(`💓 [${new Date().toLocaleTimeString()}] Win: ${windowsClients.size} | Web: ${webClients.size}`);
}, 60000);
