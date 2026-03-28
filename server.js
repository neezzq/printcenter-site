const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_me_123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'super_secret_session_key_change_me';
const COPYCENTER_NAME = process.env.COPYCENTER_NAME || 'LADOGA';
const COPYCENTER_PHONE = process.env.COPYCENTER_PHONE || '+7 (999) 123-45-67';
const COPYCENTER_EMAIL = process.env.COPYCENTER_EMAIL || 'print@example.com';
const COPYCENTER_ADDRESS = process.env.COPYCENTER_ADDRESS || 'г. Москва, ул. Пример, 10';
const UPLOAD_MAX_FILES = Number(process.env.UPLOAD_MAX_FILES || 20);
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 100);

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

ensureDir(DATA_DIR);
ensureDir(UPLOADS_DIR);
ensureOrdersFile();

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT_DIR, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const folder = path.join(
      UPLOADS_DIR,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0')
    );
    ensureDir(folder);
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeFilename(file.originalname);
    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    cb(null, `${unique}-${safeName}`);
  },
});

const allowedExtensions = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.rtf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.cdr', '.ai', '.psd', '.xls', '.xlsx', '.ppt', '.pptx'
]);

const upload = multer({
  storage,
  limits: {
    fileSize: UPLOAD_MAX_MB * 1024 * 1024,
    files: UPLOAD_MAX_FILES,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedExtensions.has(ext)) {
      return cb(new Error(`Файл ${file.originalname} имеет неподдерживаемый формат`));
    }
    cb(null, true);
  },
});

const paperOptions = [
  { value: 'A5', label: 'A5' },
  { value: 'A4', label: 'A4' },
  { value: 'A3', label: 'A3' },
  { value: 'A2', label: 'A2' },
  { value: 'A1', label: 'A1' },
  { value: 'A0', label: 'A0' },
];

const fillOptions = [
  { value: 'scale1', label: 'До 5% — текст и чертежи' },
  { value: 'scale2', label: 'От 5% до 50%' },
  { value: 'scale3', label: 'От 50%' },
];

const priceTable = {
  bw: {
    scale1: { A5: null, A4: 20, A3: 40, A2: 100, A1: 150, A0: 250 },
    scale2: { A5: null, A4: 30, A3: 60, A2: 150, A1: 250, A0: 400 },
    scale3: { A5: null, A4: 60, A3: 120, A2: 300, A1: 500, A0: 800 },
  },
  color: {
    scale1: { A5: null, A4: 40, A3: 80, A2: 150, A1: 250, A0: 350 },
    scale2: { A5: null, A4: 60, A3: 120, A2: 250, A1: 500, A0: 700 },
    scale3: { A5: null, A4: 90, A3: 180, A2: 500, A1: 800, A0: 1100 },
  },
};

const statuses = ['Новый', 'В работе', 'Готов', 'Выдан', 'Отменен'];

app.locals.site = {
  name: COPYCENTER_NAME,
  phone: COPYCENTER_PHONE,
  email: COPYCENTER_EMAIL,
  address: COPYCENTER_ADDRESS,
  logoPath: '/logo-ladoga.png',
};

app.locals.paperOptions = paperOptions;
app.locals.fillOptions = fillOptions;
app.locals.statuses = statuses;
app.locals.priceTable = priceTable;

app.get('/', (req, res) => {
  const initialValues = {
    fullName: '',
    phone: '',
    email: '',
    paperSize: 'A4',
    printType: 'bw',
    fillScale: 'scale1',
    sides: 'single',
    copies: 1,
    pages: 1,
    deliveryType: 'pickup',
    dueDate: '',
    address: '',
    comment: '',
    urgent: false,
    agree: true,
  };

  const initialPricing = estimatePrice(initialValues);

  res.render('index', {
    success: req.query.success === '1',
    error: req.query.error || '',
    values: initialValues,
    pricing: initialPricing,
    priceLabels: {
      bw: 'Чёрно-белая печать',
      color: 'Цветная печать',
    },
  });
});

app.post('/order', upload.array('files', UPLOAD_MAX_FILES), (req, res) => {
  try {
    const body = req.body || {};
    const files = Array.isArray(req.files) ? req.files : [];

    if (!body.fullName || !body.phone) {
      cleanupFiles(files);
      return res.redirect('/?error=' + encodeURIComponent('Укажи имя и телефон'));
    }

    if (!files.length) {
      return res.redirect('/?error=' + encodeURIComponent('Загрузи хотя бы один файл'));
    }

    if (body.deliveryType === 'delivery' && !body.address) {
      cleanupFiles(files);
      return res.redirect('/?error=' + encodeURIComponent('Укажи адрес доставки'));
    }

    if (!body.agree) {
      cleanupFiles(files);
      return res.redirect('/?error=' + encodeURIComponent('Подтверди согласие на обработку данных'));
    }

    const order = buildOrder(body, files);
    const orders = readOrders();
    orders.unshift(order);
    writeOrders(orders);

    return res.redirect('/?success=1');
  } catch (error) {
    console.error('Order create error:', error);
    return res.redirect('/?error=' + encodeURIComponent('Не удалось отправить заказ'));
  }
});

app.get('/admin/login', (req, res) => {
  if (req.session.admin) {
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: '' });
});

app.post('/admin/login', (req, res) => {
  const password = String(req.body.password || '');
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).render('admin-login', { error: 'Неверный пароль' });
  }

  req.session.admin = true;
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  const orders = readOrders();
  res.render('admin', {
    orders,
    activeStatus: String(req.query.status || ''),
    activeSearch: String(req.query.search || ''),
    fillLabels: Object.fromEntries(fillOptions.map((item) => [item.value, item.label])),
  });
});

app.post('/admin/order/:id/status', requireAdmin, (req, res) => {
  const orderId = req.params.id;
  const nextStatus = String(req.body.status || '');
  const adminNote = String(req.body.adminNote || '').trim();
  const orders = readOrders();
  const order = orders.find((item) => item.id === orderId);

  if (!order) {
    return res.status(404).send('Заказ не найден');
  }

  if (!statuses.includes(nextStatus)) {
    return res.status(400).send('Неверный статус');
  }

  order.status = nextStatus;
  order.updatedAt = new Date().toISOString();
  if (adminNote) {
    order.adminNote = adminNote;
  }
  writeOrders(orders);
  res.redirect('/admin');
});

app.get('/uploads/*', requireAdmin, (req, res) => {
  const requestedPath = req.params[0] || '';
  const normalizedPath = path.normalize(requestedPath).replace(/^([.][.][/\\])+/, '');
  const absolutePath = path.join(UPLOADS_DIR, normalizedPath);

  if (!absolutePath.startsWith(UPLOADS_DIR)) {
    return res.status(403).send('Доступ запрещен');
  }

  if (!fs.existsSync(absolutePath)) {
    return res.status(404).send('Файл не найден');
  }

  res.download(absolutePath);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const message = err && err.message ? err.message : 'Ошибка сервера';
  if (req.path.startsWith('/admin')) {
    return res.status(500).send(message);
  }
  res.redirect('/?error=' + encodeURIComponent(message));
});

app.listen(PORT, () => {
  console.log(`Copycenter site started on http://0.0.0.0:${PORT}`);
});

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.redirect('/admin/login');
  }
  next();
}

function buildOrder(body, files) {
  const normalized = {
    fullName: safeText(body.fullName),
    phone: safeText(body.phone),
    email: safeText(body.email),
    paperSize: normalizeEnum(body.paperSize, paperOptions.map((item) => item.value), 'A4'),
    printType: normalizeEnum(body.printType, ['bw', 'color'], 'bw'),
    fillScale: normalizeEnum(body.fillScale, fillOptions.map((item) => item.value), 'scale1'),
    sides: normalizeEnum(body.sides, ['single', 'double'], 'single'),
    copies: normalizePositiveInt(body.copies, 1),
    pages: normalizePositiveInt(body.pages, 1),
    deliveryType: normalizeEnum(body.deliveryType, ['pickup', 'delivery'], 'pickup'),
    dueDate: safeText(body.dueDate),
    address: safeText(body.address),
    comment: safeText(body.comment),
    urgent: body.urgent === 'on' || body.urgent === true || body.urgent === 'true',
    agree: body.agree === 'on' || body.agree === true || body.agree === 'true',
  };

  const pricing = estimatePrice(normalized);

  return {
    id: createId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'Новый',
    adminNote: '',
    customer: {
      fullName: normalized.fullName,
      phone: normalized.phone,
      email: normalized.email,
      address: normalized.address,
    },
    print: {
      paperSize: normalized.paperSize,
      printType: normalized.printType,
      fillScale: normalized.fillScale,
      sides: normalized.sides,
      copies: normalized.copies,
      pages: normalized.pages,
      deliveryType: normalized.deliveryType,
      dueDate: normalized.dueDate,
      urgent: normalized.urgent,
      comment: normalized.comment,
      total: pricing.total,
      totalLabel: pricing.totalLabel,
      priceNote: pricing.note,
    },
    files: files.map((file) => ({
      originalName: file.originalname,
      storedName: path.basename(file.path),
      relativePath: path.relative(UPLOADS_DIR, file.path).split(path.sep).join('/'),
      size: file.size,
      mimeType: file.mimetype || '',
    })),
  };
}

function estimatePrice(order) {
  const base = priceTable[order.printType]?.[order.fillScale]?.[order.paperSize] ?? null;
  const copies = Math.max(1, Number(order.copies) || 1);
  const pages = Math.max(1, Number(order.pages) || 1);
  const sideMultiplier = order.sides === 'double' ? 1.8 : 1;

  if (base == null) {
    return {
      total: null,
      totalLabel: 'По запросу',
      note: 'Для формата A5 цена уточняется менеджером.',
    };
  }

  const total = Math.round(base * copies * pages * sideMultiplier);
  const notes = [];

  if (order.sides === 'double') {
    notes.push('двусторонняя печать посчитана с коэффициентом 1.8');
  }
  if (order.deliveryType === 'delivery') {
    notes.push('доставка рассчитывается отдельно');
  }
  if (order.urgent) {
    notes.push('срочность подтверждается менеджером');
  }

  return {
    total,
    totalLabel: `${formatNumber(total)} ₽`,
    note: notes.length ? `Примечание: ${notes.join(', ')}.` : 'Цена рассчитана по прайсу LADOGA.',
  };
}

function readOrders() {
  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Read orders error:', error);
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function ensureOrdersFile() {
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
    return;
  }

  const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
  if (!raw) {
    fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
  }
}

function ensureDir(target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
}

function sanitizeFilename(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Zа-яА-Я0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeEnum(value, allowed, fallback) {
  const prepared = String(value || '').trim();
  return allowed.includes(prepared) ? prepared : fallback;
}

function safeText(value) {
  return String(value || '').trim().slice(0, 5000);
}

function createId() {
  return `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function cleanupFiles(files) {
  for (const file of files || []) {
    try {
      if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (error) {
      console.error('Cleanup file error:', error);
    }
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value) || 0);
}
