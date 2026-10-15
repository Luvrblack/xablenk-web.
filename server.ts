import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import net from 'net';
import { db } from './server/db.js';
import { askCustomerServiceAI, testGeminiApiKey } from './server/gemini.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(startPort, '0.0.0.0', () => {
      s.once('close', () => resolve(startPort));
      s.close();
    });
    s.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

const app = express();

// Full CORS support for local web and mobile apps / webviews / Capacitor / Cordova
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
}));
app.use(express.json());

// Helper auth check for Admin API endpoints
function isAdminAuthorized(req: Request, res: Response, next: () => void) {
  const token = req.headers['x-admin-token'];
  // Admin credentials default 'admin' or session check
  if (!token || token !== 'xablenk_admin_secret_token') {
    res.status(401).json({ error: 'Akses tidak sah. Harap login ke C-Panel Admin.' });
    return;
  }
  next();
}

// ---------------- API ROUTES ----------------

// 1. Customer Service AI Chat Endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { message, history, whatsappNumber } = req.body;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
      return;
    }

    const response = await askCustomerServiceAI({
      message,
      history,
      whatsappNumber
    });

    res.json(response);
  } catch (err: any) {
    console.error('API /api/chat error:', err);
    res.status(500).json({
      reply: 'Mohon maaf, terjadi kendala pada server asisten AI. Silakan hubungi admin kami via WhatsApp.',
      redirectToAdmin: true
    });
  }
});

// 2. Order Management Endpoints
app.get('/api/orders', (req: Request, res: Response) => {
  try {
    const orders = db.getOrders();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data pesanan.' });
  }
});

app.post('/api/orders', (req: Request, res: Response) => {
  try {
    const { customerName, phone, address, themeName, eventDate, eventTime, services, notes } = req.body;
    if (!customerName || !phone) {
      res.status(400).json({ error: 'Nama dan Nomor WhatsApp wajib diisi.' });
      return;
    }

    const newOrder = db.createOrder({
      customerName,
      phone,
      address,
      themeName,
      eventDate,
      eventTime,
      services,
      notes,
      status: 'Pending'
    });

    res.status(201).json({ success: true, order: newOrder });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat pesanan baru.' });
  }
});

app.patch('/api/orders/:id', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const updated = db.updateOrderStatus(id, status);
    if (!updated) {
      res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
      return;
    }
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memperbarui pesanan.' });
  }
});

app.delete('/api/orders/:id', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = db.deleteOrder(id);
    if (!deleted) {
      res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
      return;
    }
    res.json({ success: true, message: 'Pesanan berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus pesanan.' });
  }
});

// 3. Event Schedule Endpoints
app.get('/api/events', (req: Request, res: Response) => {
  try {
    const events = db.getEvents();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data jadwal.' });
  }
});

app.post('/api/events', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    const { name, dateText, client, location, timeText, keterangan } = req.body;
    if (!name || !location) {
      res.status(400).json({ error: 'Nama acara dan lokasi wajib diisi.' });
      return;
    }
    const newEvent = db.createEvent({
      name,
      dateText: dateText || '',
      client: client || '',
      location,
      timeText: timeText || '',
      keterangan: keterangan || '',
      no: ''
    });
    res.status(201).json({ success: true, event: newEvent });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menambah event.' });
  }
});

app.delete('/api/events/:id', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = db.deleteEvent(id);
    if (!deleted) {
      res.status(404).json({ error: 'Event tidak ditemukan.' });
      return;
    }
    res.json({ success: true, message: 'Event berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus event.' });
  }
});

// 4. Admin AI Configuration Endpoints
app.get('/api/admin/ai/status', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    const config = db.getAiConfig();
    const hasKey = Boolean(config.resolvedKey);
    // Mask key: only show last 4 chars e.g. ...a1B4
    const maskedKey = hasKey && config.resolvedKey.length > 4
      ? '•••••••••••••' + config.resolvedKey.slice(-4)
      : hasKey ? '••••••••' : '';

    res.json({
      configured: hasKey,
      model: config.model,
      maskedKey,
      status: config.status,
      lastTested: config.lastTested,
      lastError: config.lastError
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil status AI.' });
  }
});

app.post('/api/admin/ai/config', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    const { apiKey, model } = req.body;
    db.saveAiConfig({
      apiKey: apiKey !== undefined ? apiKey : undefined,
      model: model || undefined,
      status: apiKey ? 'connected' : undefined
    });

    const updated = db.getAiConfig();
    const hasKey = Boolean(updated.resolvedKey);
    const maskedKey = hasKey && updated.resolvedKey.length > 4
      ? '•••••••••••••' + updated.resolvedKey.slice(-4)
      : hasKey ? '••••••••' : '';

    res.json({
      success: true,
      message: 'Pengaturan AI berhasil disimpan di server.',
      model: updated.model,
      maskedKey,
      status: updated.status
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan konfigurasi AI.' });
  }
});

// Test Connection Endpoint with rate-limit protection
let lastTestTimestamp = 0;
app.post('/api/admin/ai/test', isAdminAuthorized, async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (now - lastTestTimestamp < 3000) {
      res.status(429).json({ error: 'Harap tunggu beberapa detik sebelum menguji koneksi lagi.' });
      return;
    }
    lastTestTimestamp = now;

    const { apiKey, model } = req.body;
    const aiConfig = db.getAiConfig();
    const keyToTest = apiKey || aiConfig.resolvedKey;

    if (!keyToTest) {
      res.status(400).json({
        success: false,
        message: 'API Key belum diisi atau dikonfigurasi.'
      });
      return;
    }

    const result = await testGeminiApiKey(keyToTest, model || aiConfig.model);

    // Save test status
    db.saveAiConfig({
      status: result.success ? 'connected' : 'error',
      lastError: result.success ? undefined : result.message
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: 'Gagal melakukan pengujian koneksi ke Gemini API.'
    });
  }
});

app.delete('/api/admin/ai/config', isAdminAuthorized, (req: Request, res: Response) => {
  try {
    db.deleteAiConfig();
    res.json({ success: true, message: 'Google Gemini API key berhasil dihapus dari server.' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus API key.' });
  }
});

// 5. MOBILE APP INTEGRATION ENDPOINTS
app.get('/api/info', (_req: Request, res: Response) => {
  const localIp = getLocalIpAddress();
  res.json({
    app: 'XA-BLENK Event Production',
    tagline: 'Bring The Event To The Next Level',
    version: '1.0.0',
    status: 'online',
    mobileReady: true,
    localIp,
    timestamp: new Date().toISOString(),
    contacts: {
      whatsapp: '6285735007989',
      instagram: 'https://instagram.com/xablenk_audio',
      email: 'xablenk.eventproduction@gmail.com'
    },
    services: [
      'Audio System (Line Array, Monitor, Subwoofer)',
      'Lighting System (Moving Head, Beam, Par LED, Laser)',
      'Videotron (P1.9 & P3.9 Indoor/Outdoor LED Screen)',
      'Rigging & Truss (Aluminium Heavy Duty)',
      'Stage & Backdrop',
      'Full Concert & Event Production'
    ],
    endpoints: {
      orders: '/api/orders',
      events: '/api/events',
      chat: '/api/chat',
      packages: '/api/packages',
      merchandise: '/api/merchandise'
    }
  });
});

app.get('/api/packages', (_req: Request, res: Response) => {
  const packages = [
    {
      id: 'pkg-1',
      category: 'Audio',
      name: 'Audio Basic Event',
      image: 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?q=80&w=800',
      description: 'Paket suara ideal untuk acara indoor skala kecil hingga menengah seperti seminar, gathering, atau mini acoustic.',
      specs: ['2x Active Speaker 15"', '1x Digital Mixer 16 Ch', '2x Wireless Mic', 'Cables & Stands', '1x Sound Operator'],
      priceTag: 'Hubungi untuk Penawaran'
    },
    {
      id: 'pkg-2',
      category: 'Audio',
      name: 'Audio Concert Pro',
      image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?q=80&w=800',
      description: 'Sistem Line Array bertenaga besar untuk konser musik outdoor, festival, dan panggung megah.',
      specs: ['8x Line Array Speaker', '4x Dual Subwoofer 18"', 'Digital Mixer 32 Ch Stagebox', 'In-Ear Monitor & Mic Package', '2x Professional Audio Engineer'],
      priceTag: 'Hubungi untuk Penawaran'
    },
    {
      id: 'pkg-3',
      category: 'Lighting',
      name: 'Lighting Show Standard',
      image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86578?q=80&w=800',
      description: 'Pencahayaan dinamis untuk menghidupkan suasana panggung dan memukau penonton.',
      specs: ['12x PAR LED RGBW', '6x Moving Head Beam 230W', '2x Blinder 4-Eye', 'Lighting Controller DMX', '1x Lighting Operator'],
      priceTag: 'Hubungi untuk Penawaran'
    },
    {
      id: 'pkg-4',
      category: 'Videotron',
      name: 'Videotron P3.9 Outdoor Medium',
      image: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?q=80&w=800',
      description: 'Layar LED beresolusi tinggi dengan tingkat kecerahan maksimal untuk visibilitas siang & malam hari.',
      specs: ['Ukuran 6m x 4m (P3.9 Outdoor)', 'Video Processor NovaStar', 'Laptop Controller & Switcher', '1x Visual Operator'],
      priceTag: 'Hubungi untuk Penawaran'
    },
    {
      id: 'pkg-5',
      category: 'Rigging',
      name: 'Rigging Aluminium Truss 10x8',
      image: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?q=80&w=800',
      description: 'Struktur panggung kokoh bersertifikasi untuk menopang tata cahaya dan sistem suara berat.',
      specs: ['Aluminium Truss 30x30 / 40x40', 'Ground Support System 4 Hoist', 'Safety Rigging Accessories', 'Tim Instalasi & Safety'],
      priceTag: 'Hubungi untuk Penawaran'
    },
    {
      id: 'pkg-6',
      category: 'Full Production',
      name: 'Full Event Production Mega',
      image: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?q=80&w=800',
      description: 'Solusi lengkap terpadu audio, lighting show, videotron, rigging, panggung, dan kru profesional.',
      specs: ['Full Line Array Sound System', 'Grand MA Lighting & Laser Show', 'Videotron LED Screen P3.9', 'Rigging Truss 12x10 & Stage', 'Full Crew Production & Engineer'],
      priceTag: 'Hubungi untuk Penawaran'
    }
  ];
  res.json(packages);
});

app.get('/api/merchandise', (_req: Request, res: Response) => {
  const merchandise = [
    {
      id: 'm1',
      name: 'Official XA-BLENK Hoodie Tour Edition',
      image: 'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?q=80&w=800',
      price: 'Rp 250.000',
      sizes: ['S', 'M', 'L', 'XL', 'XXL', 'Custom Size'],
      description: 'Hoodie premium cotton fleece tebal dengan sablon plastisol high-density tahan lama.',
      status: 'Ready'
    },
    {
      id: 'm2',
      name: 'Crewneck Audio & Lighting Tech',
      image: 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?q=80&w=800',
      price: 'Rp 220.000',
      sizes: ['S', 'M', 'L', 'XL', 'XXL', 'Custom Size'],
      description: 'Crewneck eksklusif crew produksi dengan bordir tebal di dada dan lengan.',
      status: 'Ready'
    },
    {
      id: 'm3',
      name: 'T-Shirt Stage Production Official',
      image: 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?q=80&w=800',
      price: 'Rp 150.000',
      sizes: ['S', 'M', 'L', 'XL', 'XXL', 'Custom Size'],
      description: 'Kaos 100% Cotton Combed 24s adem dengan sablon DTF full color desain futuristik.',
      status: 'Ready'
    },
    {
      id: 'm4',
      name: 'Snapback Cap XA-BLENK Red Energy',
      image: 'https://images.unsplash.com/photo-1588850561407-ed78c282e89b?q=80&w=800',
      price: 'Rp 110.000',
      sizes: ['All Size (Adjustable)', 'Custom Size'],
      description: 'Topi snapback bordir timbul logo XA-BLENK dengan pengait belakang.',
      status: 'Ready'
    },
    {
      id: 'm5',
      name: 'Lanyard & ID Holder Crew',
      image: 'https://images.unsplash.com/photo-1618354691373-d851c5c3a990?q=80&w=800',
      price: 'Rp 45.000',
      sizes: ['Standard', 'Custom Length'],
      description: 'Tali lanyard bahan tissue premium lembut dengan cetak bolak-balik high-res.',
      status: 'Ready'
    },
    {
      id: 'm6',
      name: 'Windbreaker Jacket Event Production',
      image: 'https://images.unsplash.com/photo-1544441893-675973e31985?q=80&w=800',
      price: 'Rp 320.000',
      sizes: ['S', 'M', 'L', 'XL', 'XXL', 'Custom Size'],
      description: 'Jaket parasut anti angin dan tahan air (water repellent) cocok untuk kru panggung.',
      status: 'Pre-Order'
    }
  ];
  res.json(merchandise);
});

// ---------------- VITE & STATIC HANDLING ----------------
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Mount Vite dev server middlewares
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  // Gracefully find available port if 3000 or custom port is in use
  const preferredPort = Number(process.env.PORT) || 3001;
  const activePort = await findAvailablePort(preferredPort);
  const localIp = getLocalIpAddress();

  app.listen(activePort, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 XA-BLENK Full-Stack Event Production Server`);
    console.log(`   ➜ Local:     http://localhost:${activePort}`);
    console.log(`   ➜ Network:   http://${localIp}:${activePort} (Akses dari HP / Ponsel)`);
    console.log(`   ➜ Mobile API: http://${localIp}:${activePort}/api/info`);
    console.log(`==================================================\n`);
  });
}

startServer();
