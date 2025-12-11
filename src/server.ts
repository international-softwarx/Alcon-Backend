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
  maxHttpBufferSize: 5e6, // 5MB para imágenes
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 8080; // 🔥 Puerto 8080 para local

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Almacenar clientes
const windowsClients = new Map<string, Socket>();
const webClients = new Map<string, Socket>();

// 🔥 Tipar correctamente latestScreenshot
interface ScreenshotData {
  image: string;
  timestamp: number;
  clientId: string;
}

let latestScreenshot: ScreenshotData | null = null; // ✅ Ahora acepta el objeto

// ============================================
// ENDPOINTS HTTP
// ============================================

app.get('/ping', (req, res) => {
  res.json({ 
    status: 'online', 
    timestamp: new Date().toISOString(),
    windowsClients: windowsClients.size,
    webClients: webClients.size,
    environment: process.env.NODE_ENV || 'development' // 🔥 Indica si es local o prod
  });
});

app.post('/update', (req, res) => {
  const { text } = req.body;
  
  if (!text && text !== 0) {
    return res.status(400).json({ error: 'Text required' });
  }
  
  // Enviar a todos los clientes Windows
  windowsClients.forEach(socket => {
    socket.emit('update_overlay', { text: String(text) });
  });
  
  res.json({ 
    success: true, 
    text,
    clientsNotified: windowsClients.size
  });
});

app.post('/toggle-overlay', (req, res) => {
  const { visible } = req.body;
  
  windowsClients.forEach(socket => {
    socket.emit('toggle_overlay', { visible });
  });
  
  res.json({ success: true, visible });
});

app.get('/latest-screenshot', (req, res) => {
  if (!latestScreenshot) {
    return res.status(404).json({ error: 'No screenshot available' });
  }
  res.json(latestScreenshot);
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
      windowsClients.set(socket.id, socket);
      console.log(`💻 Cliente Windows registrado: ${socket.id}`);
      
      // Enviar screenshot más reciente al conectarse
      if (latestScreenshot) {
        socket.emit('latest_screenshot', latestScreenshot);
      }
      
    } else if (type === 'web') {
      webClients.set(socket.id, socket);
      console.log(`🌐 Cliente Web registrado: ${socket.id}`);
      
      // Enviar estado actual
      socket.emit('status_update', {
        windowsConnected: windowsClients.size,
        latestScreenshot: latestScreenshot
      });
    }
  });
  
  // Recibir screenshots desde Windows
  socket.on('screen_update', (data) => {
    latestScreenshot = {
      image: data.image,
      timestamp: data.timestamp,
      clientId: socket.id
    };
    
    // Broadcast a todos los clientes web
    webClients.forEach(webSocket => {
      webSocket.emit('screen_update', latestScreenshot);
    });
  });
  
  // Cliente web solicita screenshot
  socket.on('request_screenshot', () => {
    windowsClients.forEach(winSocket => {
      winSocket.emit('request_screenshot', {});
    });
  });
  
  // Control remoto (opcional para futuro)
  socket.on('remote_command', (data) => {
    windowsClients.forEach(winSocket => {
      winSocket.emit('execute_command', data);
    });
  });
  
  // Desconexión
  socket.on('disconnect', () => {
    if (windowsClients.has(socket.id)) {
      windowsClients.delete(socket.id);
      console.log(`💻 Windows desconectado: ${socket.id}`);
    }
    if (webClients.has(socket.id)) {
      webClients.delete(socket.id);
      console.log(`🌐 Web desconectado: ${socket.id}`);
    }
    
    // Notificar a clientes web
    webClients.forEach(webSocket => {
      webSocket.emit('status_update', {
        windowsConnected: windowsClients.size
      });
    });
  });
});

// ============================================
// SERVIDOR
// ============================================

httpServer.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  console.log(`🌍 Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Local: http://localhost:${PORT}`);
  console.log(`💻 Windows clients: ${windowsClients.size}`);
  console.log(`🌐 Web clients: ${webClients.size}`);
});

// Keep-alive
setInterval(() => {
  console.log(`💓 [${new Date().toLocaleTimeString()}] Win: ${windowsClients.size} | Web: ${webClients.size}`);
}, 60000);