const state = {
  bootstrap: null,
  user: null,
  data: null,
  page: 'dashboard',
  query: '',
  cart: [],
  paymentMethod: 'CASH',
  isSaving: false,
  report: null,
  reportKey: null,
  reportFrom: null,
  reportTo: null,
  productStats: null,
  analyticsFrom: null,
  analyticsTo: null,
  supplierStats: null,
  analyticsKey: null,
  salesHistory: null,
  salesHistoryTotal: 0,
  salesHistorySearch: '',
  salesFrom: null,
  salesTo: null, auditLogs: null, auditChainVerification: null, auditLogsKey: null, plSection: 'overview', analyticsSection: 'all', dailyBackups: null, dailyBackupsKey: null,
  expenseSection: 'monthly',
  financialMap: null,
  financialMapKey: null,
  financialMapRange: 'all',
  growthForecast: null,
  growthForecastKey: null,
};

function getModalRoot() {
  let root = document.querySelector('#modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.append(root);
  }
  return root;
}

const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bag: '<path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  box: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M3 8v9l9 5 9-5V8M12 13v9"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  store: '<path d="M3 10v10h18V10M2 10l2-7h16l2 7"/><path d="M2 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M19 12H5m7 7-7-7 7-7"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/>',
  scan: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M4 12h16"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 8h18M16 14h2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8v6M23 11h-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 4.5 1.5c-.8 1-2.1 1.2-2.1 2.8M12 17h.01"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
};

function getTheme() {
  try { return localStorage.getItem('retailos-theme') === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('retailos-theme', theme); } catch { /* Theme still applies until this page closes. */ }
}

setTheme(getTheme());
function closeAccountMenu() {
  const menu = document.querySelector('#account-menu');
  const toggle = document.querySelector('#account-menu-toggle');
  if (menu && toggle) {
    menu.hidden = true;
    document.querySelector('.sidebar')?.classList.remove('account-menu-open');
    toggle.setAttribute('aria-expanded', 'false');
  }
}

document.addEventListener('click', (event) => {
  if (event.target instanceof Element && !event.target.closest('.account-control')) closeAccountMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const menu = document.querySelector('#account-menu');
    const toggle = document.querySelector('#account-menu-toggle');
    if (menu && toggle && !menu.hidden) { closeAccountMenu(); toggle.focus(); }
  }
});
window.addEventListener('resize', closeAccountMenu);

const navItems = [
  { id: 'dashboard', label: 'الرئيسية', icon: 'grid' },
  { id: 'pos', label: 'نقطة البيع', icon: 'bag' },
  { id: 'products', label: 'المنتجات والموديلات', icon: 'box' },
  { id: 'inventory', label: 'المخزون', icon: 'store' },
  { id: 'sales', label: 'المبيعات', icon: 'chart' },
  { id: 'shifts', label: 'الورديات', icon: 'clock' },
  { id: 'suppliers', label: 'التجار والمشتريات', icon: 'users' },
  { id: 'expenses', label: 'المصروفات', icon: 'wallet' },
  { id: 'financial-map', label: 'المسار المالي', icon: 'chart' },
  { id: 'reports', label: 'الأرباح والخسائر', icon: 'chart' },
  { id: 'top-products', label: 'التقارير والإحصائيات', icon: 'chart' },
  { id: 'users', label: 'المستخدمون', icon: 'users' },
];
const extraPageTitles = { backups: 'النسخ الاحتياطي اليومي والاستعادة', 'audit-logs': 'سجل المراجعة والأمان', 'monthly-expenses': 'الالتزامات الشهرية', 'financial-map': 'المسار المالي وتدفق الأرباح', shifts: 'سجل الورديات ومتابعة الشفتات' };

function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ''}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function api(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path !== '/api/login') {
    const operation = mutationLabel(path, method);
    requireMutationConfirmation(operation);
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      state.data = null;
      render();
    }
    throw new Error(result.error || 'حصل خطأ، حاول مرة تانية');
  }
  return result;
}

function requireMutationConfirmation(operation) {
  if (!window.confirm(`هل تريد بالتأكيد ${operation}؟\nاضغط موافق للتأكيد أو إلغاء للرجوع.`)) throw new Error('تم إلغاء العملية');
}

function mutationLabel(path, method) {
  if (path === '/api/categories') return 'إضافة الفئة';
  if (/^\/api\/products\/?$/.test(path)) return 'إضافة المنتج';
  if (/^\/api\/products\/[^/?]+\/variants\/[^/?]+$/.test(path) && method === 'DELETE') return 'حذف تركيبة المنتج من القوائم (مع الاحتفاظ بسجلها وفواتيرها)';
  if (/^\/api\/products\/[^/?]+$/.test(path)) return method === 'DELETE' ? 'حذف المنتج من قائمة البيع' : 'حفظ تعديلات المنتج';
  if (path === '/api/checkout') return 'تسجيل عملية البيع';
  if (path.startsWith('/api/purchases')) return 'حفظ عملية المشتريات أو السداد';
  if (path.startsWith('/api/suppliers')) return 'حفظ بيانات التاجر';
  if (path.startsWith('/api/returns')) return 'تسجيل المرتجع';
  if (path.startsWith('/api/expenses') || path.startsWith('/api/recurring-expenses')) return 'تسجيل المصروف';
  if (path.startsWith('/api/users')) return 'حفظ تغييرات الموظف';
  if (path === '/api/account/password') return 'تغيير كلمة المرور';
  if (path.startsWith('/api/backups')) return 'تنفيذ عملية النسخ الاحتياطي';
  if (path === '/api/logout') return 'تسجيل الخروج';
  if (path === '/api/setup') return 'إنشاء حساب المدير';
  return 'تنفيذ العملية';
}

function money(value) {
  if (!value) return '—';
  if (typeof value === 'object' && value.amount && typeof value.amount === 'object') {
    value = value.amount;
  }
  const rawAmount = typeof value === 'object' ? value.amount : value;
  const minor = BigInt(String(rawAmount ?? '0').replace(/\..*$/, ''));
  const isNegative = minor < 0n;
  const absMinor = isNegative ? -minor : minor;
  const decimals = Number(value?.decimals ?? 2);
  const digits = absMinor.toString().padStart(decimals + 1, '0');
  const amount = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  const sign = isNegative ? '-' : '';
  return `${sign}${amount} ${value?.currency ?? 'EGP'}`.trim();
}

function decimalPrice(value) {
  if (!value) return '0';
  const amount = BigInt(value.amount);
  const decimals = value.decimals;
  if (!decimals) return amount.toString();
  const digits = amount.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  let str = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return new Intl.DateTimeFormat('ar-EG', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    str = str.replace(' ', 'T') + 'Z';
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str) && !str.endsWith('Z') && !/[+-]\d{2}/.test(str)) {
    str = str + 'Z';
  }
  const date = new Date(str);
  if (isNaN(date.getTime())) return String(ts);
  return new Intl.DateTimeFormat('ar-EG', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true
  }).format(date);
}

function toMinor(decimal, decimals) {
  const value = String(decimal).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('اكتب السعر كرقم صحيح');
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`العملة تسمح بحد أقصى ${decimals} خانات عشرية`);
  return `${BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0')}`;
}

function formatVariantAttributes(product, attributes, fallback = 'النمط الأساسي') {
  if (!attributes) return fallback;
  const entries = Object.entries(attributes);
  if (!entries.length) return fallback;
  return entries.map(([key, value]) => {
    const optName = product?.options?.find((option) => option.key === key)?.name ?? key;
    return `${optName}: ${value}`;
  }).join(' · ');
}

function toast(message, kind = 'success') {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 3600);
}

async function loadData(storeId, year = state.selectedExpenseYear, month = state.selectedExpenseMonth) {
  const targetStore = storeId || state.data?.selectedStoreId;
  const params = new URLSearchParams();
  if (targetStore) params.set('storeId', targetStore);
  if (year) params.set('year', String(year));
  if (month) params.set('month', String(month));
  const query = params.toString() ? `?${params.toString()}` : '';
  state.data = await api(`/api/data${query}`);
}

async function start() {
  try {
    state.bootstrap = await api('/api/bootstrap');
    if (state.bootstrap.configured) {
      try {
        const session = await api('/api/data');
        state.user = session.user;
        state.data = session;
      } catch (error) {
        if (!String(error.message).includes('تسجيل الدخول') && !String(error.message).includes('انتهت الجلسة')) throw error;
      }
    }
    render();
  } catch (error) {
    document.querySelector('#app').innerHTML = `<main class="fatal-state"><div class="brand-mark">ر</div><h1>تعذر تشغيل رَفّ</h1><p>${escapeHtml(error.message)}</p><button class="button button-primary" onclick="location.reload()">إعادة المحاولة</button></main>`;
  }
}

function render() {
  const root = document.querySelector('#app');
  if (state.bootstrap?.setupRequired) {
    root.innerHTML = setupView();
    bindSetup();
  } else if (!state.bootstrap?.configured) {
    root.innerHTML = `<main class="fatal-state"><div class="brand-mark">ر</div><h1>تعذر تحميل بيانات المتجر</h1><p>راجع إعدادات تشغيل النظام أو قاعدة البيانات.</p></main>`;
  } else if (!state.user) {
    root.innerHTML = loginView();
    bindLogin();
  } else {
    if (state.data.capabilities.cashierMode && !['pos', 'inventory', 'sales'].includes(state.page)) {
      state.page = 'pos';
    }
    root.innerHTML = shellView();
    bindShell();
  }
}

function setupView() {
  return `<main class="auth-layout"><section class="auth-story"><div class="brand-lockup"><span class="brand-mark">ر</span><span>رَفّ</span></div><div class="auth-story-copy"><span class="eyebrow">نظام إدارة المتاجر</span><h1>كل شغلك<br>في مكان واحد.</h1><p>بيانات متجرك اتجهزت. أنشئ حساب المدير للبدء.</p><div class="story-stat"><span class="story-stat-dot"></span>${escapeHtml(state.bootstrap.companyName)} · ${escapeHtml(state.bootstrap.currency)}</div></div><div class="auth-story-footer">رَفّ · إدارة المتجر من مكان واحد</div></section><section class="auth-form-panel"><div class="auth-form-wrap"><span class="eyebrow eyebrow-dark">تجهيز حساب المدير</span><h2>مرحبًا بك</h2><p class="auth-subtitle">بيانات الدخول الخاصة بمدير المتجر</p><form id="setup-form" class="form-stack"><label>اسم المدير<input name="ownerName" required minlength="2" maxlength="100" placeholder="الاسم بالكامل" autocomplete="name"></label><label>اسم المستخدم<input name="ownerUsername" required minlength="3" maxlength="30" pattern="[a-z0-9_]+" placeholder="owner" autocomplete="username"><small>حروف إنجليزية صغيرة وأرقام وشرطة سفلية</small></label><label>كلمة المرور<input name="password" type="password" required minlength="12" maxlength="128" placeholder="12 حرفًا على الأقل" autocomplete="new-password"><small>استخدم عبارة مرور طويلة يصعب تخمينها</small></label><button class="button button-primary button-wide" type="submit">إنشاء حساب المدير <span>${icon('arrow', 18)}</span></button><p class="form-footnote">بيانات الشركة والفرع تأتي من إعداد النسخة.</p></form></div></section></main>`;
}

function bindSetup() {
  document.querySelector('#setup-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/setup', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
      state.bootstrap = await api('/api/bootstrap');
      toast('تم إنشاء حساب المدير. سجّل الدخول للبدء.');
      render();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
}

function loginView() {
  return `<main class="auth-layout"><section class="auth-story"><div class="brand-lockup"><span class="brand-mark">ر</span><span>رَفّ</span></div><div class="auth-story-copy"><span class="eyebrow">أهلًا بعودتك</span><h1>متجرك شغال.<br>ابدأ يومك.</h1><p>سجّل دخولك لإدارة ${escapeHtml(state.bootstrap.companyName)}.</p><div class="story-stat"><span class="story-stat-dot"></span>بياناتك محفوظة محليًا · ${escapeHtml(state.bootstrap.currency)}</div></div><div class="auth-story-footer">رَفّ · نظام إدارة المتاجر</div></section><section class="auth-form-panel"><div class="auth-form-wrap login-form-wrap"><span class="eyebrow eyebrow-dark">تسجيل الدخول</span><h2>مرحبًا بك</h2><p class="auth-subtitle">أدخل بيانات حسابك للمتابعة</p><form id="login-form" class="form-stack"><label>اسم المستخدم<input name="username" required maxlength="30" autocomplete="username" placeholder="اسم المستخدم"></label><label>كلمة المرور<input name="password" type="password" required maxlength="128" autocomplete="current-password" placeholder="كلمة المرور"></label><button class="button button-primary button-wide" type="submit">تسجيل الدخول <span>${icon('arrow', 18)}</span></button></form><p class="form-footnote">${escapeHtml(state.bootstrap.companyName)} · مساحة عمل مستقلة</p></div></section></main>`;
}

function bindLogin() {
  document.querySelector('#login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      const session = await api('/api/login', { method: 'POST', body: JSON.stringify(values) });
      state.user = session.user;
      state.page = session.capabilities?.cashierMode ? 'pos' : 'dashboard';
      await loadData();
      render();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
}

function shellView() {
  const isCashier = state.data.user.role === 'CASHIER' || Boolean(state.data.capabilities.cashierMode);
  const cashierAllowedPages = ['pos', 'inventory', 'sales'];
  const visibleNavItems = isCashier ? navItems.filter((item) => cashierAllowedPages.includes(item.id)) : navItems;
  const pageTitle = navItems.find((item) => item.id === state.page)?.label ?? extraPageTitles[state.page] ?? 'الرئيسية';
  const menuExtraItems = `${state.data.capabilities.canManageBackups ? `<button type="button" class="account-menu-item" role="menuitem" data-page="backups">${icon('store', 17)}<span>النسخ الاحتياطي اليومي</span></button>` : ''}${state.data.capabilities.canViewAuditLogs ? `<button type="button" class="account-menu-item" role="menuitem" data-page="audit-logs">${icon('scan', 17)}<span>سجل المراجعة والأمان</span></button>` : ''}`;
  const activeShift = state.data.activeShift;
  const shiftControl = activeShift ? `
    <button type="button" id="header-end-shift-btn" class="button button-sm button-shift-active" style="background:#5948d8;border-color:#5948d8;color:#fff;box-shadow:0 2px 8px rgba(89,72,216,.25);font-weight:750;display:inline-flex;align-items:center;gap:6px;" title="الوردية مفتوحة حالياً، اضغط لإنهائها وتقفيل الدرج">
      ${icon('clock', 15)}<span>إنهاء الوردية (${escapeHtml(activeShift.shiftNumber)})</span>
    </button>
  ` : `
    <button type="button" id="header-start-shift-btn" class="button button-sm button-shift-start" style="background:#059669;border-color:#059669;color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.25);font-weight:750;display:inline-flex;align-items:center;gap:6px;" title="بدء وردية جديدة وتسجيل الحضور">
      ${icon('play', 15)}<span>بدء الوردية (تسجيل الحضور)</span>
    </button>
  `;
  const lowStockCount = state.data.summary?.lowStockCount ?? state.data.lowStock?.length ?? 0;
  const suppliersDebtCount = (state.data.suppliers ?? []).filter((s) => s.purchases.some((p) => BigInt(p.remainingAmount.amount) > 0n)).length;
  const monthlyDueCount = (state.data.monthlyExpenses ?? []).filter((m) => m.actual && BigInt(m.actual.remainingAmount.amount) > 0n).length;
  const totalAlertsCount = lowStockCount + suppliersDebtCount + monthlyDueCount;

  return `<aside class="sidebar"><div class="sidebar-brand"><span class="brand-mark">ر</span><span>رَفّ</span></div><div class="workspace-pill"><span class="workspace-dot"></span><span>${escapeHtml(state.data.company.name)}</span><span class="workspace-chevron">⌄</span></div><div class="nav-caption">القائمة الرئيسية</div><nav class="main-nav">${visibleNavItems.filter((item) => item.id !== 'expenses' || state.data.capabilities.canViewExpenses).filter((item) => item.id !== 'monthly-expenses' || state.data.capabilities.canViewMonthlyExpenses).filter((item) => item.id !== 'financial-map' || state.data.capabilities.canViewAccounting).filter((item) => item.id !== 'reports' || state.data.capabilities.canViewAccounting).filter((item) => item.id !== 'top-products' || state.data.capabilities.canViewSales).filter((item) => item.id !== 'users' || state.data.capabilities.canManageUsers).filter((item) => item.id !== 'inventory' || state.data.capabilities.canViewInventory).filter((item) => item.id !== 'products' || state.data.capabilities.canManageCatalog).filter((item) => item.id !== 'suppliers' || state.data.capabilities.canManageCatalog).filter((item) => item.id !== 'sales' || state.data.capabilities.canViewSales).map((item) => `<button class="nav-item ${state.page === item.id ? 'active' : ''}" data-page="${item.id}" aria-label="${item.label}" title="${item.label}">${icon(item.icon, 19)}<span>${item.label}</span>${item.id === 'pos' ? '<kbd>F2</kbd>' : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="account-control"><div class="sidebar-user"><div class="avatar">${escapeHtml((state.data.user.fullName ?? state.user.fullName ?? '\u0645').slice(0, 1))}</div><div class="sidebar-user-copy"><strong>${escapeHtml(state.data.user.fullName ?? state.user.fullName ?? '\u0645\u062f\u064a\u0631 \u0627\u0644\u0646\u0638\u0627\u0645')}</strong><small>${roleLabel(state.data.user.role)}</small></div><button type="button" id="account-menu-toggle" class="user-menu" aria-label="\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062d\u0633\u0627\u0628" aria-haspopup="menu" aria-expanded="false" title="\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062d\u0633\u0627\u0628">${icon('more', 19)}</button></div><div id="account-menu" class="account-menu" role="menu" hidden>${menuExtraItems}<a class="account-menu-item" role="menuitem" href="mailto:support@retailos.local">${icon('help', 17)}<span>\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u062f\u0639\u0645</span></a><button type="button" id="theme-toggle" class="account-menu-item" role="menuitem">${icon(getTheme() === 'dark' ? 'sun' : 'moon', 17)}<span>${getTheme() === 'dark' ? '\u0627\u0644\u0648\u0636\u0639 \u0627\u0644\u0641\u0627\u062a\u062d' : '\u0627\u0644\u0648\u0636\u0639 \u0627\u0644\u062f\u0627\u0643\u0646'}</span></button><button type="button" id="change-password" class="account-menu-item" role="menuitem">${icon('users', 17)}<span>\u062a\u063a\u064a\u064a\u0631 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631</span></button><button type="button" id="logout-button" class="account-menu-item" role="menuitem">${icon('logout', 17)}<span>\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062e\u0631\u0648\u062c</span></button></div></div></div></aside><main class="main-area"><header class="topbar"><div class="topbar-title"><div class="breadcrumb">مساحة العمل <span>/</span> ${pageTitle}</div><h1>${pageTitle}</h1></div><div class="topbar-actions">${shiftControl}<label class="global-search">${icon('search', 18)}<input id="global-search" placeholder="ابحث عن منتج أو فاتورة..." value="${escapeHtml(state.query)}"><kbd>⌘ K</kbd></label><button class="icon-button notification-button" id="global-notifications-btn" aria-label="التنبيهات" title="${totalAlertsCount > 0 ? `لديك ${totalAlertsCount} تنبيهات عاجلة` : 'التنبيهات'}">${icon('bell', 19)}${totalAlertsCount ? '<i></i>' : ''}</button><span class="topbar-divider"></span><label class="store-select-wrap">${icon('store', 16)}<select id="store-select" ${state.data.user.storeId ? 'disabled' : ''}>${state.data.stores.map((store) => `<option value="${store.id}" ${store.id === state.data.selectedStoreId ? 'selected' : ''}>${escapeHtml(store.name)}</option>`).join('')}</select><span class="select-arrow">⌄</span></label></div></header><section class="page-content">${pageView()}</section></main>`;
}

function roleLabel(role) {
  return ({ OWNER: 'مدير النظام', STORE_MANAGER: 'مدير فرع', CASHIER: 'كاشير', AUDITOR: 'مراجع' })[role] ?? role;
}

function journalSourceLabel(sourceType) {
  return ({ PURCHASE: 'Purchase', PURCHASE_PAYMENT: 'Supplier payment', SUPPLIER_RETURN: 'Supplier return', SALE: 'Sale', EXPENSE: 'Expense', RETURN: 'Return', TRANSFER: 'Stock transfer', ADJUSTMENT: 'Stock adjustment', SESSION_CLOSING: 'Session closing' })[sourceType] ?? sourceType;
}

function pageView() {
  if (state.data.capabilities.cashierMode) {
    if (state.page === 'inventory') return inventoryView();
    if (state.page === 'sales') return salesView();
    return posView();
  }
  if (state.page === 'pos') return posView();
  if (state.page === 'products') return productsView();
  if (state.page === 'inventory') return inventoryView();
  if (state.page === 'sales') return salesView();
  if (state.page === 'shifts') return shiftsView();
  if (state.page === 'suppliers') return suppliersView();
  if (state.page === 'expenses' && state.data.capabilities.canViewExpenses) return expensesView();
  if (state.page === 'monthly-expenses' && state.data.capabilities.canViewMonthlyExpenses) return expensesView();
  if (state.page === 'financial-map' && state.data.capabilities.canViewAccounting) return financialMapView();
  if (state.page === 'accounting' && state.data.capabilities.canViewAccounting) return accountingView();
  if (state.page === 'reports' && state.data.capabilities.canViewAccounting) return profitLossView();
  if (state.page === 'top-products' && state.data.capabilities.canViewSales) return topProductsView();
  if (state.page === 'backups' && state.data.capabilities.canManageBackups) return backupView();
  if (state.page === 'users' && state.data.capabilities.canManageUsers) return usersView(); if (state.page === 'audit-logs' && state.data.capabilities.canViewAuditLogs) return auditLogsView();
  return dashboardView();
}

function userRoleLabel(role) {
  return ({ OWNER: '\u0645\u0627\u0644\u0643 \u0627\u0644\u0646\u0638\u0627\u0645', STORE_MANAGER: '\u0645\u062f\u064a\u0631 \u0641\u0631\u0639', CASHIER: '\u0643\u0627\u0634\u064a\u0631', AUDITOR: '\u0645\u0631\u0627\u062c\u0639' })[role] ?? role;
}
function auditLogsView() {
  const verification = state.auditChainVerification;
  const entries = state.auditLogs ?? [];
  const badge = verification ? `<span class="status-pill ${verification.valid ? 'status-complete' : 'status-low'}">${verification.valid ? `سلسلة التدقيق سليمة ومؤمنة (${verification.checkedCount} سجل)` : 'تحذير: تعارض في سلسلة التوقيع الرقمي'}</span>` : '<span class="status-pill">جاري التحقق من السلسلة...</span>';
  const rows = entries.map((entry) => `<tr><td><strong>#${entry.sequenceNo}</strong></td><td>${escapeHtml(employeeDateLabel(entry.createdAt, true))}</td><td><strong>${escapeHtml(entry.actorUsername)}</strong><br><small>${escapeHtml(userRoleLabel(entry.actorRole))}</small></td><td><span class="sku-code">${escapeHtml(entry.action)}</span></td><td>${escapeHtml(entry.summary)}</td><td><span class="sku-code" title="${escapeHtml(entry.entryHash)}">${escapeHtml(entry.entryHash.slice(0, 12))}…</span></td></tr>`).join('');
  return `<section class="panel"><div class="panel-heading"><div><h3>سجل المراجعة والأمان (غير قابل للتعديل)</h3><p>جميع العمليات الحساسة موثقة ومربوطة بتوقيع رقمي متسلسل (SHA-256).</p></div>${badge}</div>${rows ? `<div class="table-scroll"><table><thead><tr><th>#</th><th>التوقيت</th><th>المستخدم</th><th>نوع العملية</th><th>البيان</th><th>بصمة التدقيق</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-row">لا توجد سجلات مراجعة حالية</div>'}</section>`;
}

function usersView() {
  const todayAttendance = state.data.todayAttendance ?? [];
  const activeUsersCount = (state.data.users ?? []).filter((u) => u.isActive).length;
  const presentCount = todayAttendance.length;

  const rows = (state.data.users ?? []).map((user) => {
    const isOwner = user.role === 'OWNER';
    const storeOptions = `${state.data.user.role === 'OWNER' ? `<option value="" ${!user.storeId ? 'selected' : ''}>كل الفروع</option>` : ''}${state.data.stores.map((store) => `<option value="${store.id}" ${user.storeId === store.id ? 'selected' : ''}>${escapeHtml(store.name)}</option>`).join('')}`;
    const att = todayAttendance.find((a) => a.userId === user.id);
    const isEmp = user.role === 'CASHIER';
    const attBadge = isEmp
      ? (att
        ? `<span class="status-pill status-complete" style="font-size:11.5px;font-weight:700;">✓ حاضر اليوم (${new Date(att.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })})</span>`
        : `<span class="status-pill status-low" style="font-size:11.5px;">لم يحضر اليوم بعد</span>`)
      : `<span class="status-pill" style="opacity:0.65;font-size:11.5px;">${userRoleLabel(user.role)}</span>`;
    const historyBtn = `<button type="button" class="button button-secondary button-sm view-attendance-btn" data-user-id="${user.id}" data-user-name="${escapeHtml(user.fullName)}" style="font-size:11.5px;padding:3px 9px;">سجل الحضور</button>`;

    const roleField = isOwner
      ? '<span class="status-pill status-complete" style="font-weight:700;">مالك النظام</span><input type="hidden" name="role" value="OWNER">'
      : '<select name="role" aria-label="صلاحية المستخدم"><option value="CASHIER" selected>كاشير</option></select>';

    return `<tr><td><button type="button" class="user-detail-button" data-user-details="${user.id}">${escapeHtml(user.fullName)}<small>عرض الملف</small></button></td><td><span class="sku-code">${escapeHtml(user.username)}</span></td><td><span class="status-pill" style="font-size:11.5px;">${userRoleLabel(user.role)}</span></td><td>${attBadge}</td><td><span class="status-pill ${user.isActive ? 'status-complete' : 'status-low'}">${user.isActive ? 'نشط' : 'موقوف'}</span></td><td>${historyBtn}</td><td><form class="user-update-form" data-user-id="${user.id}">${roleField}<select name="storeId" aria-label="فرع المستخدم">${storeOptions}</select><label class="user-active-toggle"><input type="checkbox" name="isActive" ${user.isActive ? 'checked' : ''}>نشط</label><button class="button button-secondary" type="submit">حفظ</button></form></td></tr>`;
  }).join('');
  const storeOptions = state.data.stores.map((store) => `<option value="${store.id}">${escapeHtml(store.name)}</option>`).join('');
  return `<div class="page-heading-row"><div><p class="page-lead">إدارة حسابات الكاشير ومتابعة مواعيد الحضور اليومية في المتجر.</p></div></div>
    <div class="inventory-summary" style="margin-bottom:14px;">
      <div class="inventory-summary-card">
        <span class="summary-badge summary-indigo">${icon('users', 18)}</span>
        <div><small>إجمالي فريق العمل</small><strong>${activeUsersCount} موظف نشط</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-teal">${icon('check', 18)}</span>
        <div><small>سجلوا الحضور اليوم</small><strong>${presentCount} موظف حاضر</strong></div>
      </div>
    </div>
    <section class="panel user-create-panel">
      <div class="user-create-heading"><span class="user-create-icon">${icon('users', 22)}</span><div><span class="eyebrow eyebrow-dark">إدارة الكاشير</span><h3>إضافة كاشير جديد</h3><p>أنشئ بيانات دخول الكاشير للمتجر ونقطة البيع والمخزون.</p></div></div>
      <form id="user-create-form" class="user-create-form">
        <label><span>الاسم الكامل</span><input name="fullName" required minlength="2" maxlength="100" placeholder="مثال: أحمد محمد" autocomplete="name"></label>
        <label><span>رقم الهاتف</span><input name="phone" type="tel" maxlength="32" autocomplete="tel" placeholder="مثال: 01012345678"></label>
        <label><span>اسم المستخدم</span><input name="username" required minlength="3" maxlength="30" pattern="[a-z0-9_]+" autocomplete="username" placeholder="ahmed_01"><small>أحرف إنجليزية صغيرة وأرقام وشرطة سفلية فقط.</small></label>
        <label><span>كلمة المرور المؤقتة</span><input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="12 حرفًا على الأقل"><small>كلمة قوية، ويمكن للموظف تغييرها من حسابه.</small></label>
        <label><span>الدور والصلاحية</span><select name="role" required><option value="CASHIER" selected>كاشير (نقطة البيع والمخزون والمبيعات)</option></select><small>النظام محدد لمالك المتجر والكاشير فقط.</small></label>
        <label><span>الفرع</span><select name="storeId" id="user-store-select">${state.data.user.role === 'OWNER' ? '<option value="">كل الفروع</option>' : ''}${storeOptions}</select></label>
        <label><span>تاريخ بدء العمل</span><input name="employmentStartDate" type="date" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}" required></label>
        <div class="user-create-actions"><span>تأكد من اختيار الفرع المناسب قبل إنشاء الحساب.</span><button class="button button-primary" type="submit">${icon('plus', 17)} إنشاء حساب الكاشير</button></div>
      </form>
    </section>
    <section class="panel products-panel"><div class="panel-heading"><div><h3>الموظفون ومتابعة الحضور</h3><p>${(state.data.users ?? []).length} حساب مسجل</p></div></div>${rows ? `<div class="table-scroll"><table><thead><tr><th>الاسم</th><th>المستخدم</th><th>الدور</th><th>حضور اليوم</th><th>الحالة</th><th>سجل الحضور</th><th>الإدارة</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-row">لا يوجد مستخدمون</div>`}</section>`;
}

function employeeDateLabel(value, includeTime = false) {
  if (!value) return 'غير مسجل';
  const date = new Date(includeTime ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return 'غير مسجل';
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', ...(includeTime ? { timeStyle: 'short' } : {}), timeZone: 'UTC' }).format(date);
}

function employeeTenure(value) {
  if (!value) return '\u063a\u064a\u0631 \u0645\u0633\u062c\u0644';
  const start = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.valueOf())) return '\u063a\u064a\u0631 \u0645\u0633\u062c\u0644';
  const today = new Date();
  let months = Math.max(0, (today.getUTCFullYear() - start.getUTCFullYear()) * 12 + today.getUTCMonth() - start.getUTCMonth());
  if (today.getUTCDate() < start.getUTCDate()) months = Math.max(0, months - 1);
  const years = Math.floor(months / 12), remainder = months % 12;
  if (years && remainder) return `${years} \u0633\u0646\u0629 \u0648 ${remainder} \u0634\u0647\u0631`;
  if (years) return `${years} \u0633\u0646\u0629`;
  return `${remainder} \u0634\u0647\u0631`;
}

function showEmployeeDetails(user) {
  const root = getModalRoot();
  const storeName = state.data.stores.find((store) => store.id === user.storeId)?.name ?? 'كل الفروع';
  const att = (state.data.todayAttendance ?? []).find((a) => a.userId === user.id);
  const isEmp = user.role === 'CASHIER';
  const attText = isEmp ? (att ? `✓ حاضر اليوم (${new Date(att.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })})` : 'لم يحضر اليوم بعد') : 'إدارة / مالك';
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card employee-profile-card" role="dialog" aria-modal="true" aria-labelledby="employee-profile-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">ملف الموظف</span><h2 id="employee-profile-title">${escapeHtml(user.fullName)}</h2></div><button type="button" class="modal-close" data-close-employee aria-label="إغلاق">×</button></div><div class="employee-profile-body"><div class="employee-profile-meta"><div class="employee-meta-item"><small>اسم المستخدم</small><strong>${escapeHtml(user.username)}</strong></div><div class="employee-meta-item"><small>الدور الوظيفي</small><strong>${userRoleLabel(user.role)}</strong></div><div class="employee-meta-item"><small>الفرع المعين به</small><strong>${escapeHtml(storeName)}</strong></div><div class="employee-meta-item"><small>حالة الحساب</small><strong class="${user.isActive ? 'profile-active' : 'profile-inactive'}">${user.isActive ? 'نشط ومفعل' : 'موقوف'}</strong></div><div class="employee-meta-item"><small>حضور اليوم</small><strong style="color:${att ? 'var(--green, #15803d)' : '#b45309'};">${attText}</strong></div><div class="employee-meta-item"><small>تاريخ الانضمام</small><strong>${employeeDateLabel(user.createdAt, true)}</strong></div><div class="employee-meta-item employee-meta-wide"><small>مدة العمل في المتجر</small><strong>${employeeTenure(user.employmentStartDate)}</strong></div></div><form id="employee-profile-form" data-user-id="${user.id}" class="form-stack"><div class="form-grid"><label><span>رقم الهاتف</span><input name="phone" type="tel" maxlength="32" autocomplete="tel" value="${escapeHtml(user.phone ?? '')}" placeholder="لم يُسجل رقم هاتف"></label><label><span>تاريخ بدء العمل الفعلي</span><input name="employmentStartDate" type="date" required value="${escapeHtml(user.employmentStartDate ?? '')}"></label></div><div class="modal-actions" style="margin-top:10px;"><button type="button" class="button button-secondary" data-close-employee>إغلاق</button><button type="button" class="button button-secondary" id="employee-modal-att-btn">سجل الحضور</button><button type="submit" class="button button-primary">حفظ بيانات الموظف</button></div></form></div></section></div>`;
  root.querySelectorAll('[data-close-employee]').forEach((element) => element.addEventListener('click', (event) => {
    if (element === event.target || element.tagName === 'BUTTON') root.innerHTML = '';
  }));
  root.querySelector('#employee-modal-att-btn')?.addEventListener('click', () => {
    showAttendanceHistoryModal(user.id, user.fullName);
  });
  root.querySelector('#employee-profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    const body = Object.fromEntries(new FormData(form));
    body.phone = body.phone || null;
    button.disabled = true;
    try {
      await api(`/api/users/${form.dataset.userId}`, { method: 'PATCH', body: JSON.stringify(body) });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      const updatedUser = state.data.users.find((item) => item.id === form.dataset.userId);
      if (updatedUser) showEmployeeDetails(updatedUser);
      toast('تم حفظ بيانات الموظف');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
}

async function showAttendanceHistoryModal(userId, userName) {
  const root = getModalRoot();
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" style="width:min(580px, calc(100vw - 32px));margin:20px auto;"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">سجل حضور الموظف</span><h2>${escapeHtml(userName)}</h2></div><button class="modal-close" data-close-modal>×</button></div><div style="padding:16px 20px;" id="attendance-history-content"><p style="text-align:center;color:var(--text-soft);">جاري تحميل سجل الحضور...</p></div><div class="modal-actions" style="padding:12px 20px;"><button type="button" class="button button-secondary" data-close-modal>إغلاق</button></div></section></div>`;
  root.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; }));
  try {
    const data = await api(`/api/attendance/history?userId=${encodeURIComponent(userId)}`);
    const history = data.history ?? [];
    const content = root.querySelector('#attendance-history-content');
    if (!content) return;
    if (!history.length) {
      content.innerHTML = `<div class="empty-row" style="text-align:center;padding:24px;">لا يوجد سجل حضور مسجل بعد لهذا الموظف.</div>`;
      return;
    }
    content.innerHTML = `<div class="table-scroll analytics-scroll-box" style="max-height:420px; overflow-y:auto;"><table class="compact-table zebra-table" style="width:100%;border-collapse:collapse;"><thead><tr><th>التاريخ</th><th>وقت تسجيل الحضور</th><th>الحالة</th></tr></thead><tbody>${history.map((item) => {
      const d = new Date(item.createdAt);
      const dateStr = d.toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      return `<tr><td><strong>${dateStr}</strong></td><td><span class="sku-code">${timeStr}</span></td><td><span class="status-pill status-complete" style="font-weight:700;">✓ حاضر</span></td></tr>`;
    }).join('')}</tbody></table></div>`;
  } catch (err) {
    const content = root.querySelector('#attendance-history-content');
    if (content) content.innerHTML = `<div class="status-pill status-low" style="display:block;padding:12px;">فشل تحميل السجل: ${escapeHtml(err.message)}</div>`;
  }
}

function bindUsers() {
  const form = document.querySelector('#user-create-form');
  const role = form?.elements.namedItem('role');
  const store = form?.elements.namedItem('storeId');
  const updateStoreRequirement = () => { if (store) store.required = role?.value === 'CASHIER'; };
  role?.addEventListener('change', updateStoreRequirement);
  updateStoreRequirement();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    const body = Object.fromEntries(new FormData(form));
    if (!body.storeId) delete body.storeId;
    button.disabled = true;
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
      toast('\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
  document.querySelectorAll('[data-user-details]').forEach((button) => button.addEventListener('click', () => {
    const user = (state.data.users ?? []).find((item) => item.id === button.dataset.userDetails);
    if (user) showEmployeeDetails(user);
  }));
  document.querySelectorAll('.view-attendance-btn').forEach((button) => button.addEventListener('click', () => {
    showAttendanceHistoryModal(button.dataset.userId, button.dataset.userName);
  }));
  document.querySelectorAll('.user-update-form').forEach((userForm) => userForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = event.currentTarget;
    const button = target.querySelector('[type=submit]');
    const data = Object.fromEntries(new FormData(target));
    data.isActive = target.elements.namedItem('isActive').checked;
    data.storeId = data.storeId || null;
    button.disabled = true;
    try {
      await api(`/api/users/${target.dataset.userId}`, { method: 'PATCH', body: JSON.stringify(data) });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
      toast('\u062a\u0645 \u062a\u062d\u062f\u064a\u062b \u0635\u0644\u0627\u062d\u064a\u0627\u062a \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  }));
}

function showChangePasswordModal() {
  const root = getModalRoot();
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="password-modal-title"><div class="modal-heading"><div><h2 id="password-modal-title">تغيير كلمة المرور</h2></div><button type="button" class="modal-close" data-close-password>×</button></div><form id="account-password-form" class="form-stack"><label>كلمة المرور الحالية<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>كلمة المرور الجديدة<input name="newPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><label>تأكيد كلمة المرور<input name="confirmPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><div class="modal-actions"><button type="button" class="button button-secondary" data-close-password>إلغاء</button><button type="submit" class="button button-primary">حفظ كلمة المرور</button></div></form></section></div>`;
  const clearAndClose = () => {
    root.querySelectorAll('input[type="password"]').forEach((i) => { i.value = ''; });
    root.innerHTML = '';
  };
  root.querySelectorAll('[data-close-password]').forEach((button) => button.addEventListener('click', clearAndClose));
  root.querySelector('#account-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
    if (data.newPassword !== data.confirmPassword) { toast('كلمتا المرور غير متطابقتين', 'error'); return; }
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }) });
      form.querySelectorAll('input[type="password"]').forEach((i) => { i.value = ''; });
      state.user = null; state.data = null; state.cart = []; root.innerHTML = ''; render();
      toast('تغيرت كلمة المرور. سجل الدخول بالكلمة الجديدة.');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
}

function dashboardView() {
  const data = state.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'صباح الخير' : hour < 17 ? 'يومك سعيد' : 'مساء الخير';
  const sales = data.sales.slice(0, 5);
  const maxRevenue = data.sales.slice(0, 7).reduce((max, sale) => BigInt(sale.total.amount) > max ? BigInt(sale.total.amount) : max, 1n);
  const weekBars = ['س', 'ح', 'ن', 'ث', 'ر', 'خ', 'ج'];
  return `<div class="welcome-row"><div><div class="welcome-date">${new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div><h2>${greeting}، ${escapeHtml((data.user.fullName ?? 'مدير النظام').split(' ')[0])} </h2><p>ده ملخص سريع للي بيحصل في متجرك النهارده.</p></div><button class="button button-primary" data-page="pos">${icon('plus', 18)} عملية بيع جديدة</button></div><div class="metric-grid"><article class="metric-card"><div class="metric-head"><span>مبيعات اليوم</span><span class="metric-icon metric-purple">${icon('wallet', 19)}</span></div><strong>${data.summary.todayRevenue ? money(data.summary.todayRevenue) : '—'}</strong><div class="metric-foot"><span class="metric-muted">${data.summary.todaySalesCount ?? '—'} فاتورة اليوم</span><span class="metric-period">اليوم</span></div></article><article class="metric-card"><div class="metric-head"><span>عدد الفواتير</span><span class="metric-icon metric-green">${icon('bag', 19)}</span></div><strong>${data.summary.todaySalesCount ?? '—'}</strong><div class="metric-foot"><span class="metric-muted">إجمالي العمليات المكتملة</span><span class="metric-positive">اليوم</span></div></article><article class="metric-card"><div class="metric-head"><span>أصناف المنتجات</span><span class="metric-icon metric-blue">${icon('box', 19)}</span></div><strong>${data.summary.productCount}</strong><div class="metric-foot"><span class="metric-muted">منتج مسجل في الكتالوج</span><span class="metric-period">الكتالوج</span></div></article><article class="metric-card"><div class="metric-head"><span>تنبيهات المخزون</span><span class="metric-icon metric-orange">${icon('store', 19)}</span></div><strong>${data.summary.lowStockCount}</strong><div class="metric-foot"><span class="metric-muted">منتجات عند حد إعادة الطلب</span><button class="text-action" data-page="inventory">عرض القائمة ←</button></div></article></div><div class="dashboard-grid"><section class="panel sales-panel"><div class="panel-heading"><div><h3>حركة المبيعات</h3><p>آخر عمليات البيع المسجلة على النظام</p></div><button class="text-action" data-page="sales">كل المبيعات <span>←</span></button></div>${data.sales.length ? `<div class="chart-legend"><span><i></i>قيمة الفاتورة</span><span class="chart-period">آخر الفواتير</span></div><div class="sales-chart">${data.sales.slice(0, 7).reverse().map((sale, index) => `<div class="chart-column"><span class="bar-tooltip">${money(sale.total)}</span><div class="chart-bar ${index === 6 ? 'bar-highlight' : ''}" style="height:${Math.max(12, Number((BigInt(sale.total.amount) * 100n) / maxRevenue))}%"></div><span class="chart-label">${new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' }).format(new Date(sale.createdAt))}</span></div>`).join('')}</div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('chart', 28)}</div><strong>المبيعات هتظهر هنا</strong><p>أول ما تسجل عملية بيع، هتلاقي ملخصها في الصفحة دي.</p><button class="button button-secondary" data-page="pos">ابدأ أول عملية بيع</button></div>`}</section><section class="panel stock-panel"><div class="panel-heading"><div><h3>محتاج إعادة طلب</h3><p>المنتجات اللي عندها تركيبات وصلت لحد الطلب</p></div><button class="icon-button small-icon" data-page="inventory">${icon('arrow', 17)}</button></div>${data.lowStock.length ? `<div class="stock-list">${data.lowStock.slice(0, 5).map((item) => `<div class="stock-row"><div class="stock-thumb">${icon('box', 17)}</div><div class="stock-copy"><strong>${escapeHtml(item.productName)}</strong><small>${item.lowVariantCount} تركيبة تحتاج طلب</small></div><span class="stock-count">${item.quantity} <small>إجمالي</small></span></div>`).join('')}</div>` : `<div class="empty-inline"><span class="empty-check">✓</span><strong>المخزون تمام</strong><p>مفيش أصناف محتاجة إعادة طلب حاليًا.</p></div>`}</section></div><section class="panel recent-panel"><div class="panel-heading"><div><h3>آخر الفواتير</h3><p>متابعة سريعة لأحدث عمليات البيع</p></div><button class="text-action" data-page="sales">عرض الكل <span>←</span></button></div>${sales.length ? salesTable(sales) : `<div class="empty-row">لسه مفيش فواتير. سجّل أول عملية بيع عشان تبدأ تتابع الحركة.</div>`}</section>`;
}

function salesTable(sales) {
  return `
    <div class="sales-table-scroll-container">
      <table class="sales-table zebra-table">
        <thead>
          <tr>
            <th>رقم الفاتورة</th>
            <th>التاريخ والوقت</th>
            <th>الكاشير / البائع</th>
            <th>الأصناف</th>
            <th>طريقة الدفع</th>
            <th>الإجمالي</th>
            <th>الحالة</th>
            <th style="text-align:center;">الإجراءات</th>
          </tr>
        </thead>
        <tbody>
          ${(sales ?? []).map((sale) => {
            const d = new Date(sale.createdAt);
            const dateStr = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
            const timeStr = new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' }).format(d);
            const totalItems = (sale.items ?? []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
            const canReturn = (state.data.capabilities.canRefund || state.data.capabilities.canReturnSale || state.data.capabilities.cashierMode) && (sale.items ?? []).some((item) => BigInt(item.returnableQuantity ?? '0') > 0n);
            
            const paymentPills = (sale.payments ?? []).map((payment) => {
              const method = payment.method;
              const cls = method === 'CASH' ? 'payment-pill-cash' : method === 'CARD' ? 'payment-pill-card' : method === 'MOBILE' ? 'payment-pill-mobile' : 'payment-pill-other';
              return `<span class="payment-pill ${cls}">${methodLabel(method)}</span>`;
            }).join(' ');

            return `
              <tr>
                <td>
                  <button type="button" class="invoice-id-btn invoice-open" data-sale-open="${sale.id}">
                    #${escapeHtml(sale.saleNumber)}
                  </button>
                </td>
                <td>
                  <div class="sales-date-box">
                    <strong>${dateStr}</strong>
                    <small>${timeStr}</small>
                  </div>
                </td>
                <td>
                  <span class="sales-cashier-pill">${escapeHtml(sale.cashierName || 'كاشير')}</span>
                </td>
                <td>
                  <span class="sales-qty-pill">${totalItems} قطعة</span>
                </td>
                <td>
                  <div style="display:inline-flex;gap:4px;flex-wrap:wrap;">
                    ${paymentPills}
                  </div>
                </td>
                <td>
                  <strong class="table-total" style="font-size:13.5px;color:var(--ink);">${money(sale.total)}</strong>
                </td>
                <td>
                  <span class="status-pill status-complete" style="font-size:11px;font-weight:800;">مكتملة</span>
                </td>
                <td style="text-align:center;">
                  <div style="display:inline-flex;align-items:center;gap:6px;justify-content:center;">
                    <button type="button" class="button button-secondary button-sm invoice-open" data-sale-open="${sale.id}" style="height:30px;padding:0 10px;font-size:12px;font-weight:700;">
                      تفاصيل
                    </button>
                    ${canReturn ? `
                      <button type="button" class="button button-secondary button-sm start-return" data-sale="${sale.id}" style="height:30px;padding:0 10px;font-size:12px;color:var(--rose,var(--rose, #be123c));border-color:var(--rose,var(--rose, #be123c));font-weight:750;">
                        مرتجع
                      </button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function methodLabel(method) {
  return ({ CASH: 'نقدي', CARD: 'بطاقة', MOBILE: 'محفظة', OTHER: 'أخرى' })[method] ?? method;
}

const COLOR_OPTION_NAMES = new Set(['color', 'colour', 'لون', 'اللون', 'الالوان', 'الألوان']);
const SIZE_OPTION_NAMES = new Set(['size', 'مقاس', 'المقاس', 'المقاسات']);
const COLOR_CODE_MAP = new Map([
  ['أسود', 'BLK'], ['اسود', 'BLK'], ['black', 'BLK'],
  ['أبيض', 'WHT'], ['ابيض', 'WHT'], ['white', 'WHT'],
  ['كحلي', 'NVY'], ['كحلى', 'NVY'], ['navy', 'NVY'],
  ['بيج', 'BGE'], ['beige', 'BGE'],
  ['رمادي', 'GRY'], ['رمادى', 'GRY'], ['رصاصي', 'GRY'], ['gray', 'GRY'], ['grey', 'GRY'],
  ['بني', 'BRN'], ['بنى', 'BRN'], ['brown', 'BRN'],
  ['هافان', 'HVN'], ['tan', 'HVN'],
  ['زيتي', 'OLV'], ['زيتى', 'OLV'], ['olive', 'OLV'],
  ['جملي', 'CML'], ['جملى', 'CML'], ['camel', 'CML'],
  ['نبيتي', 'MRN'], ['نبيتى', 'MRN'], ['عنابي', 'MRN'], ['maroon', 'MRN'], ['burgundy', 'MRN'],
  ['أحمر', 'RED'], ['احمر', 'RED'], ['red', 'RED'],
  ['أزرق', 'BLU'], ['ازرق', 'BLU'], ['لبني', 'BLU'], ['blue', 'BLU'],
  ['أخضر', 'GRN'], ['اخضر', 'GRN'], ['green', 'GRN'],
  ['وردي', 'PNK'], ['بمبي', 'PNK'], ['بينك', 'PNK'], ['pink', 'PNK'],
  ['أصفر', 'YLW'], ['اصفر', 'YLW'], ['مسطردة', 'YLW'], ['yellow', 'YLW'],
  ['برتقالي', 'ORG'], ['اورنج', 'ORG'], ['orange', 'ORG'],
  ['بنفسجي', 'PRP'], ['موف', 'PRP'], ['purple', 'PRP'],
  ['ذهبي', 'GLD'], ['ذهبى', 'GLD'], ['gold', 'GLD'],
  ['فضي', 'SLV'], ['فضى', 'SLV'], ['سيلفر', 'SLV'], ['silver', 'SLV'],
  ['كافيه', 'CAF'], ['نسكافيه', 'CAF'], ['coffee', 'CAF'],
  ['طوبي', 'BRK'], ['طوبى', 'BRK'],
  ['منت', 'MNT'], ['مينت', 'MNT'], ['mint', 'MNT'],
  ['أوف وايت', 'OFW'], ['اوف وايت', 'OFW'], ['سكري', 'OFW'], ['كريمي', 'OFW'],
]);

function attributeValueToSkuCode(val, fallbackIdx = 1) {
  const raw = String(val ?? '').trim();
  if (!raw) return `V${fallbackIdx}`;
  const lower = raw.toLowerCase();
  if (COLOR_CODE_MAP.has(lower)) return COLOR_CODE_MAP.get(lower);
  const ascii = raw.replace(/[^A-Za-z0-9.]/g, '').toUpperCase();
  if (ascii.length >= 1) return ascii.slice(0, 6);
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash * 31) + raw.charCodeAt(i)) % 900;
  return `C${String(100 + hash)}`;
}

function buildSemanticVariantSku(baseSku, attributes, index, usedSkus) {
  const cleanBase = (String(baseSku || 'ITEM').trim().toUpperCase().replace(/\s+/g, '-') || 'ITEM').slice(0, 38);
  const values = Object.values(attributes ?? {}).map((v, i) => attributeValueToSkuCode(v, i + 1)).filter(Boolean);
  const core = values.length ? `${cleanBase}-${values.join('-')}` : `${cleanBase}-${String(index + 1).padStart(2, '0')}`;
  let candidate = core.slice(0, 60);
  let counter = 2;
  while (usedSkus.has(candidate.toLowerCase())) {
    candidate = `${core.slice(0, 56)}-${counter++}`;
  }
  return candidate;
}

function generateEan13Barcode(seedText, seqIndex = 1, usedBarcodes = new Set()) {
  let hash = 2166136261;
  const input = `${seedText}:${seqIndex}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let attempt = Math.abs(hash);
  while (true) {
    const body9 = String((attempt % 900000000) + 100000000).slice(0, 9);
    const digits12 = `200${body9}`;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
    const check = (10 - (sum % 10)) % 10;
    const ean13 = `${digits12}${check}`;
    if (!usedBarcodes.has(ean13)) {
      usedBarcodes.add(ean13);
      return ean13;
    }
    attempt += 7919;
  }
}

function renderBarcodeSvg(codeText) {
  const sanitized = String(codeText || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  const text = sanitized || '000000000000';
  const bars = ['11010010000'];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    const p1 = ((ch * 7 + i * 3) % 3) + 1;
    const s1 = ((ch * 3 + i) % 2) + 1;
    const p2 = ((ch * 5 + i * 2) % 3) + 1;
    const s2 = ((ch + i) % 2) + 1;
    const p3 = Math.max(1, 11 - (p1 + s1 + p2 + s2 + 2));
    bars.push(`${'1'.repeat(p1)}${'0'.repeat(s1)}${'1'.repeat(p2)}${'0'.repeat(s2)}${'1'.repeat(p3)}0`);
  }
  bars.push('1100011101011');
  const bitString = bars.join('');
  let rects = '';
  let x = 0;
  for (let i = 0; i < bitString.length; i += 1) {
    if (bitString[i] === '1') rects += `<rect x="${x}" y="0" width="1.4" height="34" fill="#111827"/>`;
    x += 1.4;
  }
  return `<svg class="barcode-svg" viewBox="0 0 ${Math.ceil(x)} 36" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}

function computeSerieWeight(sizes, sizeValue, mode = 'standard') {
  if (mode !== 'standard' || sizes.length < 3) return 1;
  const idx = sizes.indexOf(sizeValue);
  if (idx < 0) return 1;
  const midStart = Math.floor((sizes.length - 1) / 3);
  const midEnd = Math.ceil(((sizes.length - 1) * 2) / 3);
  return idx >= midStart && idx <= midEnd ? 2 : 1;
}

function extractProductMatrix(product) {
  const activeVariants = (product.variants ?? []).filter((variant) => variant.isActive);
  const options = product.options ?? [];
  let colorOption = options.find((opt) => COLOR_OPTION_NAMES.has(String(opt.name ?? '').trim().toLowerCase()) || COLOR_OPTION_NAMES.has(String(opt.key ?? '').trim().toLowerCase()));
  let sizeOption = options.find((opt) => SIZE_OPTION_NAMES.has(String(opt.name ?? '').trim().toLowerCase()) || SIZE_OPTION_NAMES.has(String(opt.key ?? '').trim().toLowerCase()));
  if (!colorOption && !sizeOption && options.length >= 2) {
    colorOption = options[0];
    sizeOption = options[1];
  } else if (!colorOption && !sizeOption && options.length === 1) {
    const firstVals = options[0].values ?? [];
    const looksLikeSize = firstVals.every((v) => /^(?:\d{2}|[xXsSmMlL]{1,4}|\d{1,2}\.\d)$/.test(String(v).trim()));
    if (looksLikeSize) sizeOption = options[0];
    else colorOption = options[0];
  }
  const colors = [];
  const sizes = [];
  const addUnique = (list, val) => { if (val && !list.includes(val)) list.push(val); };
  if (colorOption) for (const v of colorOption.values ?? []) addUnique(colors, String(v).trim());
  if (sizeOption) for (const v of sizeOption.values ?? []) addUnique(sizes, String(v).trim());
  for (const variant of activeVariants) {
    const attrs = variant.attributes ?? {};
    const cVal = colorOption ? attrs[colorOption.key] ?? attrs[colorOption.name] : null;
    const sVal = sizeOption ? attrs[sizeOption.key] ?? attrs[sizeOption.name] : null;
    if (cVal) addUnique(colors, String(cVal).trim());
    if (sVal) addUnique(sizes, String(sVal).trim());
  }
  const hasAttributes = activeVariants.some((v) => Object.keys(v.attributes ?? {}).length > 0);
  const isMatrix = hasAttributes && (colors.length > 0 || sizes.length > 0);
  const effectiveColors = colors.length ? colors : ['الأساسي'];
  const effectiveSizes = sizes.length ? sizes : ['موحد'];
  const matrixMap = new Map();
  for (const variant of activeVariants) {
    const attrs = variant.attributes ?? {};
    const cVal = colorOption ? (attrs[colorOption.key] ?? attrs[colorOption.name] ?? 'الأساسي') : 'الأساسي';
    const sVal = sizeOption ? (attrs[sizeOption.key] ?? attrs[sizeOption.name] ?? 'موحد') : 'موحد';
    matrixMap.set(`${String(cVal).trim()}:::${String(sVal).trim()}`, variant);
  }
  const sizeRangeLabel = sizes.length > 2 ? `مقاس ${sizes[0]}–${sizes[sizes.length - 1]} (${sizes.length})` : sizes.length ? `مقاس ${sizes.join(' · ')}` : '';
  const colorSummaryLabel = colors.length ? `${colors.slice(0, 4).join(' · ')}${colors.length > 4 ? ` +${colors.length - 4}` : ''}` : '';
  return {
    activeVariants,
    colorOption,
    sizeOption,
    colors: effectiveColors,
    rawColors: colors,
    sizes: effectiveSizes,
    rawSizes: sizes,
    isMatrix,
    matrixMap,
    sizeRangeLabel,
    colorSummaryLabel,
  };
}

function productsView() {
  const query = state.query.trim().toLowerCase();
  const products = state.data.products.filter((product) => !query || `${product.name} ${product.sku} ${product.brand ?? ''} ${product.variants.map((item) => `${item.sku} ${item.barcode ?? ''} ${Object.values(item.attributes ?? {}).join(' ')}`).join(' ')}`.toLowerCase().includes(query));
  const rows = products.map((product) => {
    const matrix = extractProductMatrix(product);
    const activeVariants = matrix.activeVariants;
    const totalQuantity = activeVariants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
    const priceRange = activeVariants.length ? (new Set(activeVariants.map((variant) => variant.price.amount)).size === 1 ? money(activeVariants[0].price) : `${money(activeVariants.reduce((min, variant) => BigInt(variant.price.amount) < BigInt(min.price.amount) ? variant : min, activeVariants[0]).price)} – ${money(activeVariants.reduce((max, variant) => BigInt(variant.price.amount) > BigInt(max.price.amount) ? variant : max, activeVariants[0]).price)}`) : '—';
    const subSummary = matrix.isMatrix
      ? `<div class="model-sub-badges">${matrix.rawColors.length ? `<span class="model-chip model-chip-color">${escapeHtml(matrix.colorSummaryLabel)}</span>` : ''}${matrix.rawSizes.length ? `<span class="model-chip model-chip-size">${escapeHtml(matrix.sizeRangeLabel)}</span>` : ''}<small class="model-sub-count">${activeVariants.length} فرع (لون×مقاس)</small></div>`
      : `<span class="model-sub-count">${activeVariants.length === 1 ? 'صنف مباشر (بدون مقاسات)' : `${activeVariants.length} تركيبة`}</span>`;
    return `<tr><td><div class="product-table-name"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand ? `${product.brand} · كود الموديل ${product.sku}` : `كود الموديل: ${product.sku}`)}</small></span></div></td><td><span class="sku-code">${escapeHtml(product.sku)}</span></td><td>${subSummary}</td><td class="table-total">${priceRange}</td><td><strong>${totalQuantity}</strong> قطعة</td><td class="product-actions"><button type="button" class="text-action product-print-labels" data-product-id="${product.id}">طباعة باركود</button><button type="button" class="text-action product-edit" data-product-id="${product.id}">المقاسات والتعديل</button><button type="button" class="text-action product-delete" data-product-id="${product.id}">حذف</button></td></tr>`;
  }).join('');
  return `<div class="page-heading-row"><div><p class="page-lead">إدارة وتعديل أصناف وكتالوج المتجر بسهولة وسرعة.</p></div><div class="products-heading-actions"><button class="button button-secondary" id="add-category">${icon('plus', 18)} إضافة فئة</button><button class="button button-primary" id="new-product">${icon('plus', 18)} إضافة موديل / منتج</button></div></div><section class="panel products-panel"><div class="panel-heading"><div><h3>كتالوج الموديلات والمنتجات</h3><p>${state.data.products.length} موديل أساسي في الكتالوج</p></div><label class="table-search">${icon('search', 17)}<input class="local-search" placeholder="بحث باسم الموديل أو الكود أو اللون أو المقاس" value="${escapeHtml(state.query)}"></label></div>${products.length ? `<div class="table-scroll"><table><thead><tr><th>الموديل / المنتج</th><th>كود الموديل</th><th>الألوان والمقاسات الفرعية</th><th>سعر البيع</th><th>إجمالي الرصيد</th><th>الإجراءات</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('box', 28)}</div><strong>${query ? 'مفيش نتائج مطابقة' : 'الكتالوج لسه فاضي'}</strong><p>${query ? 'جرب كلمة بحث تانية.' : 'أضف الموديل بكوده الأساسي وحدد الألوان والمقاسات، وبعدها استقبل الكميات في فاتورة الشراء.'}</p>${!query ? '<button class="button button-primary" id="empty-new-product">إضافة أول موديل</button>' : ''}</div>`}</section>`;
}

function inventoryView() {
  const data = state.data;
  const currency = data.company.currency;
  const decimals = currencyDecimals(currency);

  const catalogProducts = data.products.filter((product) => product.itemKind === 'PRODUCT' && product.isActive);
  let totalStockUnits = 0n;
  let totalStockCostMinor = 0n;
  let totalStockRetailMinor = 0n;
  let lowStockModelsCount = 0;
  let inStockModelsCount = 0;
  for (const p of catalogProducts) {
    const activeVariants = p.variants.filter((item) => item.isActive);
    let modelHasStock = false;
    let modelHasLow = false;
    for (const v of activeVariants) {
      const q = BigInt(v.quantity);
      const rp = BigInt(v.reorderPoint ?? 0);
      if (q <= rp) modelHasLow = true;
      if (q > 0n) {
        modelHasStock = true;
        totalStockUnits += q;
        if (v.wac) totalStockCostMinor += q * BigInt(v.wac.amount);
        totalStockRetailMinor += q * BigInt(v.price?.amount ?? v.retailPrice?.amount ?? 0);
      }
    }
    if (modelHasLow) lowStockModelsCount += 1;
    if (modelHasStock) inStockModelsCount += 1;
  }
  const expectedStockProfitMinor = totalStockRetailMinor - totalStockCostMinor;
  const isNegativeExpectedProfit = expectedStockProfitMinor < 0n;
  const expectedProfitColor = isNegativeExpectedProfit ? 'var(--rose, var(--rose, #be123c))' : 'var(--green, #15803d)';

  const items = data.products.filter((product) => product.itemKind === 'PRODUCT').map((product) => {
    const matrix = extractProductMatrix(product);
    const variants = matrix.activeVariants;
    const quantity = variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
    const reorderPoint = variants.reduce((sum, variant) => sum + BigInt(variant.reorderPoint), 0n);
    const hasLowVariant = variants.some((variant) => BigInt(variant.quantity) <= BigInt(variant.reorderPoint));
    const cost = variants.length && variants.every((variant) => variant.wac) ? (() => {
      const weight = variants.reduce((sum, variant) => sum + (BigInt(variant.quantity) > 0n ? BigInt(variant.quantity) : 0n), 0n);
      if (weight <= 0n) return variants[0]?.wac ?? null;
      const amount = variants.reduce((sum, variant) => {
        const q = BigInt(variant.quantity);
        return q > 0n ? sum + q * BigInt(variant.wac.amount) : sum;
      }, 0n) / weight;
      return { ...variants[0].wac, amount: amount.toString() };
    })() : null;
    const unitRetail = (() => {
      const priced = variants.filter((variant) => variant.price ?? variant.retailPrice);
      if (!priced.length) return null;
      const weight = priced.reduce((sum, variant) => sum + (BigInt(variant.quantity) > 0n ? BigInt(variant.quantity) : 0n), 0n);
      const firstPrice = priced[0].price ?? priced[0].retailPrice;
      if (weight <= 0n) return firstPrice;
      const amount = priced.reduce((sum, variant) => {
        const q = BigInt(variant.quantity);
        const p = variant.price ?? variant.retailPrice;
        return q > 0n ? sum + q * BigInt(p.amount) : sum;
      }, 0n) / weight;
      return { ...firstPrice, amount: amount.toString() };
    })();
    return { ...product, matrix, variants, quantity, reorderPoint, hasLowVariant, cost, unitRetail };
  }).filter((product) => product.isActive && (!state.query.trim() || `${product.name} ${product.sku} ${product.brand ?? ''} ${product.variants.map((variant) => `${variant.sku} ${Object.values(variant.attributes ?? {}).join(' ')}`).join(' ')}`.toLowerCase().includes(state.query.trim().toLowerCase())));

  const isCashier = Boolean(data.capabilities.cashierMode);
  const summaryCardsHtml = isCashier ? `
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">إجمالي البضاعة بالمخزن</small>
        <strong style="font-size:18px;display:block;margin-top:2px;">${totalStockUnits} قطعة</strong>
        <span style="font-size:11px;color:var(--muted);">${catalogProducts.length} موديل مسجل</span>
      </div>
    </div>
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">موديلات متوفرة</small>
        <strong style="font-size:18px;display:block;margin-top:2px;color:var(--green, #15803d);">${inStockModelsCount} موديل</strong>
        <span style="font-size:11px;color:var(--muted);">متاح للبيع حالياً</span>
      </div>
    </div>
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">مقاسات تحتاج طلب</small>
        <strong style="font-size:18px;display:block;margin-top:2px;color:${lowStockModelsCount > 0 ? 'var(--amber, #d97706)' : 'var(--green, #15803d)'};">${lowStockModelsCount} موديل</strong>
        <span style="font-size:11px;color:var(--muted);">وصلت لحد إعادة الطلب</span>
      </div>
    </div>` : `
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">إجمالي البضاعة بالمخزن</small>
        <strong style="font-size:18px;display:block;margin-top:2px;">${totalStockUnits} قطعة</strong>
        <span style="font-size:11px;color:var(--muted);">${catalogProducts.length} موديل مسجل</span>
      </div>
    </div>
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">سعر التكلفة الفعلي (رأس المال)</small>
        <strong style="font-size:18px;display:block;margin-top:2px;color:var(--ink);">${money({ amount: totalStockCostMinor.toString(), currency, decimals })}</strong>
        <span style="font-size:11px;color:var(--muted);">بسعر الشراء الفعلي (WAC)</span>
      </div>
    </div>
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">القيمة البيعية للبضاعة</small>
        <strong style="font-size:18px;display:block;margin-top:2px;color:var(--purple);">${money({ amount: totalStockRetailMinor.toString(), currency, decimals })}</strong>
        <span style="font-size:11px;color:var(--muted);">إجمالي سعر البيع للقطع</span>
      </div>
    </div>
    <div class="inventory-summary-card">
      <div>
        <small style="color:var(--muted);font-size:11.5px;font-weight:700;">المكسب والربح المتوقع منها</small>
        <strong style="font-size:18px;display:block;margin-top:2px;color:${expectedProfitColor};">${money({ amount: expectedStockProfitMinor.toString(), currency, decimals })}</strong>
        <span style="font-size:11px;color:${expectedProfitColor};font-weight:600;">${isNegativeExpectedProfit ? 'عجز متوقع مقارنة بالتكلفة' : 'هامش ربح تقريبي عند البيع'}</span>
      </div>
    </div>`;

  return `<div class="page-heading-row"><div><p class="page-lead">${isCashier ? 'متابعة أرصدة المخزون والمقاسات والأسعار المتاحة للبيع.' : 'متابعة وجرد أرصدة المخزون للموديلات والأصناف الحالية وتقييم رأس المال والأرباح المتوقعة.'}</p></div><div class="products-heading-actions">${data.capabilities.canManageStores ? '<button class="button button-secondary" id="new-store-btn">+ إضافة فرع</button>' : ''}${data.capabilities.canTransferInventory && data.stores.length > 1 ? '<button class="button button-secondary" id="transfer-stock-btn">تحويل مخزون بين الفروع</button>' : ''}${data.capabilities.canViewInventory && !isCashier ? '<button class="button button-secondary" id="record-damage-btn">تسجيل تالف / هالك</button><button class="button button-secondary" id="adjust-stock-btn">تسوية جرد فعلي</button>' : ''}<a class="button button-secondary" href="/api/reports/export.csv?type=inventory&storeId=${encodeURIComponent(data.selectedStoreId)}" download>تصدير CSV</a>${!isCashier ? `<button class="button button-primary" data-page="suppliers">فاتورة شراء من تاجر</button>` : ''}</div></div>
  <div class="inventory-summary" style="grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px;">${summaryCardsHtml}
  </div>
  <section class="panel"><div class="panel-heading"><div><h3>أرصدة الموديلات والمقاسات</h3><p>اضغط على الموديل لعرض مصفوفة الألوان والمقاسات</p></div><label class="table-search">${icon('search', 17)}<input class="local-search" placeholder="ابحث عن الموديل أو الكود أو المقاس" value="${escapeHtml(state.query)}"></label></div>${items.length ? `<div class="table-scroll"><table><thead><tr><th>الموديل</th><th>كود الموديل</th><th>الألوان والمقاسات</th><th style="text-align:center;">إجمالي الرصيد</th>${!isCashier ? '<th>سعر التكلفة (الفعلي)</th><th>سعر البيع</th><th>المكسب المتوقع</th>' : '<th>سعر البيع</th>'}<th>حالة المقاسات</th></tr></thead><tbody>${items.map((product) => `<tr><td><button type="button" class="product-name-action inventory-product-details" data-product-id="${product.id}"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand || 'اضغط لعرض جدول المقاسات')}</small></span></button></td><td><span class="sku-code">${escapeHtml(product.sku)}</span></td><td>${product.matrix.isMatrix ? `<div class="model-sub-badges">${product.matrix.rawColors.length ? `<span class="model-chip model-chip-color">${escapeHtml(product.matrix.colorSummaryLabel)}</span>` : ''}${product.matrix.rawSizes.length ? `<span class="model-chip model-chip-size">${escapeHtml(product.matrix.sizeRangeLabel)}</span>` : ''}</div>` : `<small>${product.variants.length} نسخة</small>`}</td><td style="text-align:center;"><strong>${product.quantity}</strong> قطعة</td>${!isCashier ? (() => {
  const unitRetail = product.unitRetail;
  const unitCost = product.cost;
  let unitProfitStr = '—';
  let unitProfitColor = 'var(--green, #15803d)';
  if (unitRetail && unitCost) {
    const profitMinor = BigInt(unitRetail.amount) - BigInt(unitCost.amount);
    if (profitMinor < 0n) unitProfitColor = 'var(--rose, var(--rose, #be123c))';
    unitProfitStr = money({ amount: profitMinor.toString(), currency: unitRetail.currency, decimals: unitRetail.decimals });
  }
  return `
    <td>${unitCost ? money(unitCost) : '—'}</td>
    <td><strong style="color:var(--purple);">${unitRetail ? money(unitRetail) : '—'}</strong></td>
    <td><strong style="color:${unitProfitColor};">${unitProfitStr}</strong><br><small style="color:var(--muted);font-size:10px;">لكل قطعة</small></td>
  `;
})() : `
  <td><strong style="color:var(--purple);">${product.unitRetail ? money(product.unitRetail) : '—'}</strong></td>
`}<td>${product.hasLowVariant ? '<span class="status-pill status-low">مقاسات تحتاج طلب</span>' : '<span class="status-pill status-complete">متوفر</span>'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('box', 28)}</div><strong>مفيش منتجات في المخزون</strong><p>سجّل فاتورة شراء لإضافة البضاعة للمخزون.</p>${!isCashier ? '<button class="button button-primary" data-page="suppliers">فاتورة شراء</button>' : ''}</div>`}</section>`;
}

function salesView() {
  const returns = state.data.customerReturns ?? [];
  const sales = state.salesHistory ?? state.data.sales ?? [];
  const totalCount = state.salesHistoryTotal ?? state.data.sales?.length ?? sales.length;
  const today = new Date().toISOString().slice(0, 10);
  const preset = state.salesPreset ?? 'today';
  if (state.salesFrom === undefined && state.salesPreset !== 'all') {
    state.salesFrom = today;
    state.salesTo = today;
  }
  const from = state.salesFrom ?? today;
  const to = state.salesTo ?? today;

  return `
    <div class="page-heading-row">
      <div>
        <p class="page-lead">كل فواتير البيع محفوظة. اختر فترة أو ابحث برقم الفاتورة أو اسم المنتج، وافتح أي فاتورة لعرض تفاصيلها أو تسجيل مرتجع.</p>
      </div>
      <button class="button button-primary" data-page="pos">${icon('plus', 18)} بيع جديد</button>
    </div>

    <section class="pro-filter-card">
      <div class="pro-filter-row" style="margin-bottom:12px;">
        <div class="pro-filter-pills">
          <span style="font-size:12px;font-weight:700;color:var(--muted);display:inline-flex;align-items:center;gap:6px;">
            ${icon('filter', 15)} فترات المبيعات:
          </span>
          <button type="button" class="pro-filter-pill ${preset === 'today' ? 'active' : ''}" data-sales-preset="today">اليوم</button>
          <button type="button" class="pro-filter-pill ${preset === 'week' ? 'active' : ''}" data-sales-preset="week">هذا الأسبوع</button>
          <button type="button" class="pro-filter-pill ${preset === 'month' ? 'active' : ''}" data-sales-preset="month">هذا الشهر</button>
          <button type="button" class="pro-filter-pill ${preset === 'all' ? 'active' : ''}" data-sales-preset="all">كل المبيعات</button>
        </div>
      </div>
      <form id="sales-history-search" class="pro-filter-row">
        <div class="pro-search-wrap">
          ${icon('search', 16)}
          <input name="search" value="${escapeHtml(state.salesHistorySearch ?? '')}" placeholder="ابحث برقم الفاتورة أو اسم الموديل أو الكود...">
        </div>
        <div class="pro-date-inputs">
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} من:</label>
            <input type="date" name="from" value="${from}">
          </div>
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} إلى:</label>
            <input type="date" name="to" value="${to}">
          </div>
          <button class="button button-primary button-sm" type="submit" style="height:38px;padding:0 16px;">تطبيق الفلتر</button>
          ${from || to || (state.salesHistorySearch ?? '').trim() ? '<button type="button" id="reset-sales-filter" class="text-action" style="font-size:12px;color:var(--rose,var(--rose, #be123c));font-weight:700;">مسح الفلتر</button>' : ''}
        </div>
      </form>
    </section>

    <section class="panel recent-panel">
      <div class="panel-heading">
        <div>
          <h3>فواتير البيع</h3>
          <p>${sales.length} من ${totalCount} فاتورة</p>
        </div>
      </div>
      ${sales.length ? `${salesTable(sales)}${sales.length < totalCount ? '<div class="sales-history-more"><button class="button button-secondary" id="sales-history-more">عرض فواتير أقدم</button></div>' : ''}` : `<div class="empty-chart"><div class="empty-illustration">${icon('chart', 28)}</div><strong>${state.salesHistorySearch ? 'لا توجد فواتير مطابقة للبحث' : 'لا توجد مبيعات مسجلة في هذه الفترة'}</strong><button class="button button-primary" data-page="pos">ابدأ البيع</button></div>`}
    </section>

    <div style="margin: 32px 0 16px; border-top: 2px dashed var(--line); padding-top: 20px;">
      <div class="panel-heading" style="margin-bottom: 10px;">
        <div>
          <h3 style="font-size: 15px; font-weight: 800; color: var(--ink);">سجل فواتير المرتجعات السابقة</h3>
          <p style="font-size: 11px; color: var(--muted);">كل عمليات الاسترجاع المسجلة على فواتير المبيعات مع المبالغ المستردة والمخزون المرتجع</p>
        </div>
        <span class="status-pill status-complete">${returns.length} حركة مرتجع</span>
      </div>
    </div>

    <details class="panel compact-disclosure" ${returns.length ? 'open' : ''}>
      <summary style="padding:12px 18px;">
        <span style="font-size:13.5px;font-weight:750;color:var(--ink);">عرض جدول المرتجعات التفصيلي</span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="status-pill status-complete">${returns.length} مرتجع</span>
          <span class="disclosure-chevron" aria-hidden="true">${icon('chevron', 16)}</span>
        </div>
      </summary>
      <div class="disclosure-content">
        ${returns.length ? `
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>رقم المرتجع</th>
                  <th>الفاتورة الأصلية</th>
                  <th>تاريخ وتوقيت المرتجع</th>
                  <th>طريقة رد المبلغ</th>
                  <th>المبلغ المسترد</th>
                </tr>
              </thead>
              <tbody>
                ${returns.map((item) => `
                  <tr>
                    <td><strong>${escapeHtml(item.returnNumber)}</strong></td>
                    <td><span class="sku-code">${escapeHtml(item.saleNumber)}</span></td>
                    <td>${new Date(item.createdAt).toLocaleString('ar-EG')}</td>
                    <td><span class="payment-chip">${methodLabel(item.paymentMethod)}</span></td>
                    <td class="table-total" style="color:var(--rose,var(--rose, #be123c));">${money(typeof item.refundAmount === 'object' ? item.refundAmount : { amount: item.refundAmount, currency: item.currency, decimals: currencyDecimals(item.currency) })}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="empty-row">لا توجد مرتجعات مسجلة في هذا المتجر حتى الآن.</div>'}
      </div>
    </details>
  `;
}

async function loadShifts() {
  const storeId = state.data?.selectedStoreId;
  const params = new URLSearchParams();
  if (storeId) params.set('storeId', storeId);
  if (state.shiftFrom) params.set('from', state.shiftFrom);
  if (state.shiftTo) params.set('to', state.shiftTo);
  if (state.shiftUser) params.set('userId', state.shiftUser);
  const q = params.toString() ? `?${params.toString()}` : '';
  try {
    state.shiftsData = await api(`/api/shifts${q}`);
    render();
  } catch (err) {
    state.shiftsData = { shifts: [], summary: {}, loadError: err.message };
    render();
    toast(err.message, 'error');
  }
}

function shiftsView() {
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);
  const format = (v) => money({ amount: v, currency, decimals });
  const isCashier = state.data.user.role === 'CASHIER' || Boolean(state.data.capabilities.cashierMode);
  const activePreset = state.shiftPreset || 'today';
  const shiftsData = state.shiftsData;

  if (!shiftsData) {
    void loadShifts();
    return `<div class="panel empty-chart" style="padding:60px 20px;"><div class="empty-illustration">${icon('clock', 32)}</div><strong>جاري تحميل سجل الورديات...</strong><p>يتم تجميع كافة ورديات الشفتات ومبيعات كل كاشير.</p></div>`;
  }

  const { shifts = [], summary = {} } = shiftsData;

  return `
    <div class="page-heading-row">
      <div>
        <p class="page-lead">سجل ورديات الموظفين: متابعة بدء وانتهاء الشفتات، جرد الأدراج، المبيعات المحققة، والتوريدات.</p>
      </div>
      <div>
        ${state.data.activeShift ? `
          <button type="button" class="button button-primary" id="shifts-end-now-btn" style="background:#5948d8;border-color:#5948d8;">
            ${icon('clock', 16)} إنهاء الوردية الحالية (${escapeHtml(state.data.activeShift.shiftNumber)})
          </button>
        ` : `
          <button type="button" class="button button-primary" id="shifts-start-now-btn" style="background:#059669;border-color:#059669;">
            ${icon('play', 16)} بدء وردية جديدة
          </button>
        `}
      </div>
    </div>

    <section class="pro-filter-card" style="margin-bottom:18px;">
      <div class="pro-filter-row">
        <div class="pro-filter-pills">
          <span style="font-size:12px;font-weight:700;color:var(--muted);display:inline-flex;align-items:center;gap:6px;">
            ${icon('filter', 15)} تصفية الورديات:
          </span>
          <button type="button" class="pro-filter-pill ${activePreset === 'all' ? 'active' : ''}" data-shift-preset="all">كل الورديات</button>
          <button type="button" class="pro-filter-pill ${activePreset === 'today' ? 'active' : ''}" data-shift-preset="today">اليوم</button>
          <button type="button" class="pro-filter-pill ${activePreset === 'week' ? 'active' : ''}" data-shift-preset="week">هذا الأسبوع</button>
          <button type="button" class="pro-filter-pill ${activePreset === 'month' ? 'active' : ''}" data-shift-preset="month">هذا الشهر</button>
        </div>
        <form id="shifts-date-filter" class="pro-date-inputs">
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} من:</label>
            <input type="date" name="from" value="${state.shiftFrom || ''}">
          </div>
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} إلى:</label>
            <input type="date" name="to" value="${state.shiftTo || ''}">
          </div>
          <button type="submit" class="button button-primary button-sm" style="height:38px;padding:0 14px;">تطبيق</button>
        </form>
      </div>
    </section>

    <div class="fm-card-grid" style="grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 18px;">
      <div class="fm-kpi-card">
        <small>إجمالي عدد الورديات</small>
        <strong style="color:var(--ink);">${summary.totalShifts ?? shifts.length} وردية</strong>
        <small style="color:var(--muted);">${activePreset === 'today' ? 'اليوم' : 'في الفترة المحددة'}</small>
      </div>
      <div class="fm-kpi-card">
        <small>إجمالي مبيعات الورديات</small>
        <strong style="color:var(--green, #15803d);">${format(summary.totalSales ?? '0')}</strong>
        <small style="color:var(--muted);">المحصل من كافة الفواتير</small>
      </div>
      ${!isCashier ? `
        <div class="fm-kpi-card fm-kpi-profit">
          <small style="color:var(--purple);font-weight:750;">إجمالي أرباح الورديات</small>
          <strong>${format(summary.totalProfit ?? '0')}</strong>
          <small style="color:var(--muted);">مجمل ربح البضاعة المباعة</small>
        </div>
      ` : ''}
      <div class="fm-kpi-card">
        <small>صافي عجز / زيادة الأدراج</small>
        <strong style="color:${BigInt(summary.totalVariance ?? '0') === 0n ? 'var(--green, #15803d)' : BigInt(summary.totalVariance ?? '0') > 0n ? 'var(--blue, #2563eb)' : 'var(--rose,var(--rose, #be123c))'};">
          ${BigInt(summary.totalVariance ?? '0') === 0n ? 'متطابق (0.00)' : format(summary.totalVariance ?? '0')}
        </strong>
        <small style="color:var(--muted);">فروقات الجرد الفعلي</small>
      </div>
    </div>

    <section class="panel compact-panel">
      <div class="panel-heading">
        <div>
          <h3 style="font-size:16px;font-weight:800;color:var(--ink);">قائمة الورديات المسجلة (${shifts.length} وردية)</h3>
          <p>تفاصيل كل شفت، توقيت الحضور والانصراف، مبيعات الكاشير، ورصيد التوريد والتسليم.</p>
        </div>
      </div>

      ${shifts.length ? `
        <div class="table-scroll analytics-scroll-box" style="max-height:550px; overflow-y:auto;">
          <table class="compact-table zebra-table">
            <thead>
              <tr>
                <th>رقم الوردية</th>
                <th>الموظف المسؤول</th>
                <th>البداية والانتهاء</th>
                <th>مدة الشفت</th>
                <th>الافتتاحي</th>
                <th>إجمالي المبيعات</th>
                ${!isCashier ? '<th>الأرباح</th>' : ''}
                <th>المتوقع بالدرج</th>
                <th>الفعلي المعدود</th>
                <th style="text-align:center;">الفارق</th>
                <th>المبلغ المورد</th>
                <th style="text-align:center;">الفواتير</th>
              </tr>
            </thead>
            <tbody>
              ${shifts.map((s) => {
                const varianceNum = BigInt(s.variance || '0');
                const varianceBadge = varianceNum === 0n
                  ? '<span class="status-pill status-complete" style="font-size:11px;">متطابق ✓</span>'
                  : varianceNum > 0n
                  ? `<span class="status-pill status-complete" style="background:var(--blue-soft);color:var(--blue);border-color:var(--blue);font-size:11px;">+${format(s.variance)} (زيادة)</span>`
                  : `<span class="status-pill status-low" style="font-size:11px;">${format(s.variance)} (عجز)</span>`;
                return `
                  <tr>
                    <td><strong style="color:var(--purple);font-family:monospace;letter-spacing:0.5px;">${escapeHtml(s.shiftNumber)}</strong></td>
                    <td><strong>${escapeHtml(s.userName)}</strong><br><small style="color:var(--muted);">${roleLabel(s.userRole)}</small></td>
                    <td>
                      <div>${new Date(s.startedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })} ${new Date(s.startedAt).toLocaleDateString('ar-EG', { month: 'numeric', day: 'numeric' })}</div>
                      <div style="font-size:11px;color:var(--muted);">${s.endedAt ? `${new Date(s.endedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}` : '<span style="color:var(--green, #15803d);font-weight:700;">مفتوحة حالياً</span>'}</div>
                    </td>
                    <td><span class="sku-code">${escapeHtml(s.duration)}</span></td>
                    <td>${format(s.openingCash)}</td>
                    <td><strong style="color:var(--green, #15803d);">${format(s.salesRevenue)}</strong><br><small style="color:var(--muted);">${s.salesCount} فاتورة</small></td>
                    ${!isCashier ? `<td><strong style="color:var(--purple);">${format(s.grossProfit ?? '0')}</strong></td>` : ''}
                    <td>${format(s.expectedCash)}</td>
                    <td><strong>${s.status === 'OPEN' ? '—' : format(s.actualCash)}</strong></td>
                    <td style="text-align:center;">${s.status === 'OPEN' ? '<span class="status-pill" style="font-size:11px;">قيد العمل</span>' : varianceBadge}</td>
                    <td><strong>${format(s.handoverCash)}</strong></td>
                    <td style="text-align:center;">
                      <button type="button" class="button button-sm button-secondary view-shift-sales-btn" data-shift-id="${s.id}" data-shift-number="${escapeHtml(s.shiftNumber)}" style="font-size:11.5px;padding:3px 10px;">
                        عرض الفواتير (${s.salesCount})
                      </button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-chart" style="padding:40px 16px;">
          <div class="empty-illustration">${icon('clock', 32)}</div>
          <strong>لا توجد ورديات مسجلة في هذه الفترة</strong>
          <p>ابدأ وردية جديدة ليتم احتساب المبيعات وحركات الدرج تلقائياً.</p>
        </div>
      `}
    </section>
  `;
}

async function showShiftSalesModal(shiftId, shiftNumber) {
  const root = getModalRoot();
  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card invoice-detail-card" role="dialog" aria-modal="true" style="width:min(860px, calc(100vw - 32px)); border-radius:16px;">
        <div class="modal-heading" style="padding:18px 26px; border-bottom:1px solid var(--line);">
          <div>
            <span class="eyebrow eyebrow-dark">فواتير مبيعات الوردية</span>
            <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
              <h2 style="margin:0;font-size:18px;font-weight:800;">فواتير الوردية</h2>
              <span class="invoice-number-chip">#${escapeHtml(shiftNumber)}</span>
            </div>
          </div>
          <button class="modal-close" data-close-modal aria-label="إغلاق">×</button>
        </div>
        <div id="shift-sales-content" class="modal-body" style="padding:22px 26px; overflow-y:auto;">
          <p style="text-align:center;color:var(--muted);">جاري تحميل الفواتير...</p>
        </div>
        <div class="modal-actions" style="margin:0; padding:16px 26px; border-top:1px solid var(--line); display:flex; justify-content:flex-end;">
          <button type="button" class="button button-secondary" data-close-modal>إغلاق</button>
        </div>
      </section>
    </div>
  `;
  root.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; }));

  try {
    const data = await api(`/api/shifts/${encodeURIComponent(shiftId)}/sales`);
    const currency = data.currency;
    const decimals = currencyDecimals(currency);
    const format = (v) => money({ amount: v, currency, decimals });
    const content = root.querySelector('#shift-sales-content');
    if (!content) return;
    const sales = data.sales ?? [];

    if (!sales.length) {
      content.innerHTML = `<div class="empty-row" style="text-align:center;padding:24px;">لم يتم تسجيل أي فواتير بيع خلال هذه الوردية.</div>`;
      return;
    }

    content.innerHTML = `
      <div class="invoice-table-container">
        <div class="table-scroll analytics-scroll-box" style="max-height:450px; overflow-y:auto; margin:0;">
          <table class="compact-table zebra-table invoice-table" style="margin:0; width:100%;">
            <thead>
              <tr>
                <th>رقم الفاتورة</th>
                <th>التوقيت</th>
                <th>العميل</th>
                <th>طريقة السداد</th>
                <th style="text-align:center;">عدد الأصناف</th>
                <th>إجمالي الفاتورة</th>
                ${sales[0]?.grossProfit !== null && sales[0]?.grossProfit !== undefined ? '<th>الربح المحقق</th>' : ''}
                <th style="text-align:center;">الإيصال</th>
              </tr>
            </thead>
            <tbody>
              ${sales.map((s) => `
                <tr>
                  <td><span class="invoice-number-chip" style="font-size:11.5px;padding:2px 7px;">#${escapeHtml(s.saleNumber)}</span></td>
                  <td>${new Date(s.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</td>
                  <td><strong>${escapeHtml(s.customerName)}</strong></td>
                  <td><span class="payment-badge">${methodLabel(s.paymentMethod)}</span></td>
                  <td style="text-align:center;">${s.itemsCount}</td>
                  <td><strong style="color:var(--green, #15803d);">${format(s.total)}</strong></td>
                  ${s.grossProfit !== null && s.grossProfit !== undefined ? `<td><strong style="color:var(--purple);">${format(s.grossProfit)}</strong></td>` : ''}
                  <td style="text-align:center;">
                    <button type="button" class="button button-sm button-secondary print-shift-sale-btn" data-sale-id="${s.id}" style="font-size:11px;padding:2px 8px;">
                      معاينة الإيصال
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    content.querySelectorAll('.print-shift-sale-btn').forEach((btn) => btn.addEventListener('click', () => {
      void showThermalReceiptModal(btn.dataset.saleId);
    }));
  } catch (err) {
    const content = root.querySelector('#shift-sales-content');
    if (content) content.innerHTML = `<div class="status-pill status-low">${escapeHtml(err.message)}</div>`;
  }
}

function showStartShiftModal() {
  const root = getModalRoot();
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card" role="dialog" aria-modal="true" style="width:min(460px, calc(100vw - 32px));margin:20px auto;">
        <div class="modal-heading">
          <div>
            <span class="eyebrow eyebrow-dark">نظام الورديات والحضور</span>
            <h2>بدء الوردية وتسجيل الحضور</h2>
          </div>
          <button class="modal-close" data-close-modal>×</button>
        </div>
        <form id="start-shift-form" class="form-stack modal-form" style="padding:16px 20px;">
          <p style="font-size:13px;color:var(--muted);margin:0 0 14px;line-height:1.5;">
            أدخل المبلغ المستلم في الدرج (عهدة البداية) للبدء في البيع وتسجيل الحضور فوراً.
          </p>
          <label style="font-weight:750;display:flex;flex-direction:column;gap:6px;">المبلغ المستلم في الدرج (${currency}) *
            <input name="openingCash" id="start-shift-opening-cash" inputmode="decimal" value="0.00" required placeholder="0.00" style="font-size:18px;font-weight:800;color:var(--ink);padding:10px 12px;" autofocus>
          </label>
          <div class="modal-actions" style="margin-top:20px;padding:0;">
            <button type="button" class="button button-secondary" data-close-modal>إلغاء</button>
            <button type="submit" class="button button-primary" style="background:#059669;border-color:#059669;font-weight:750;padding:8px 20px;">بدء الوردية الآن</button>
          </div>
        </form>
      </section>
    </div>
  `;
  root.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; }));

  const inputEl = root.querySelector('#start-shift-opening-cash');
  inputEl?.focus();
  inputEl?.select();

  root.querySelector('#start-shift-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const submitBtn = form.querySelector('[type=submit]');
    submitBtn.disabled = true;
    try {
      const data = new FormData(form);
      const openingCashMinor = toMinor(data.get('openingCash') || '0', decimals);
      const res = await api('/api/shifts/start', {
        method: 'POST',
        body: JSON.stringify({
          storeId: state.data.selectedStoreId,
          openingCash: openingCashMinor,
          notes: '',
        })
      });
      root.innerHTML = '';
      toast(`تم بدء الوردية #${res.shift.shiftNumber} بنجاح وتسجيل الحضور`);
      await loadData(state.data.selectedStoreId);
      render();
    } catch (err) {
      toast(err.message, 'error');
      submitBtn.disabled = false;
    }
  });
}

async function showEndShiftModal() {
  const root = getModalRoot();
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);
  const format = (v) => money({ amount: v, currency, decimals });
  const isCashier = state.data.user.role === 'CASHIER' || Boolean(state.data.capabilities.cashierMode);

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card" role="dialog" aria-modal="true" style="width:min(580px, calc(100vw - 32px));margin:20px auto;">
        <div class="modal-heading">
          <div>
            <span class="eyebrow eyebrow-dark">نظام الورديات والحسابات</span>
            <h2>تقفيل وتسليم الوردية</h2>
          </div>
          <button class="modal-close" data-close-modal>×</button>
        </div>
        <div id="end-shift-modal-body" style="padding:16px 20px;">
          <p style="text-align:center;color:var(--muted);">جاري تجميع حركات الوردية الحالية...</p>
        </div>
      </section>
    </div>
  `;
  root.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; }));

  try {
    const { currentShift } = await api(`/api/shifts/current?storeId=${encodeURIComponent(state.data.selectedStoreId)}`);
    if (!currentShift) {
      root.innerHTML = '';
      toast('لا توجد وردية مفتوحة حالياً', 'error');
      return;
    }

    const modalBody = root.querySelector('#end-shift-modal-body');
    if (!modalBody) return;

    if (isCashier) {
      modalBody.innerHTML = `
        <div style="background:var(--surface-soft);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">
            <span>الوردية الحالية: <strong style="color:var(--purple);font-family:monospace;">${escapeHtml(currentShift.shiftNumber)}</strong></span>
            <span>بدأت الساعة: <strong>${new Date(currentShift.startedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</strong></span>
          </div>
          <div style="margin-top:8px;font-size:12px;color:var(--muted);border-top:1px dashed var(--line);padding-top:8px;">
            المبلغ المستلم عند البداية: <strong style="color:var(--ink);">${format(currentShift.openingCash)}</strong>
          </div>
        </div>

        <form id="end-shift-form" class="form-stack">
          <label style="font-weight:750;display:flex;flex-direction:column;gap:6px;">المبلغ المسلم بنهاية الوردية (${currency}) *
            <input name="handoverCash" id="shift-handover-cash" inputmode="decimal" required placeholder="0.00" style="font-size:18px;font-weight:800;color:var(--ink);padding:10px 12px;" autofocus>
            <small style="color:var(--muted);font-size:11.5px;">عِدّ النقدية الموجودة بالدرج وسلّم المبلغ واكتب قيمته هنا للإغلاق.</small>
          </label>

          <div class="modal-actions" style="margin-top:20px;padding:0;">
            <button type="button" class="button button-secondary" data-close-modal>إلغاء</button>
            <button type="submit" class="button button-primary" style="background:#5948d8;border-color:#5948d8;font-weight:750;padding:8px 20px;">تأكيد تسليم النقدية وإنهاء الوردية</button>
          </div>
        </form>
      `;

      const cashInput = modalBody.querySelector('#shift-handover-cash');
      cashInput?.focus();
      cashInput?.select();

      modalBody.querySelector('#end-shift-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const submitBtn = form.querySelector('[type=submit]');
        submitBtn.disabled = true;
        try {
          const formData = new FormData(form);
          const enteredMinor = toMinor(formData.get('handoverCash') || '0', decimals);
          const res = await api('/api/shifts/end', {
            method: 'POST',
            body: JSON.stringify({
              shiftId: currentShift.id,
              actualCash: enteredMinor,
              handoverCash: enteredMinor,
              notes: 'تسليم وردية كاشير',
            })
          });
          root.innerHTML = '';
          toast(`تم إنهاء الوردية #${res.shift.shiftNumber} بنجاح وتسليم الدرج`);
          await loadData(state.data.selectedStoreId);
          render();
        } catch (err) {
          toast(err.message, 'error');
          submitBtn.disabled = false;
        }
      });
      return;
    }

    const expectedCashBig = BigInt(currentShift.expectedCash || '0');

    modalBody.innerHTML = `
      <div style="background:var(--surface-soft);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:12.5px;">
          <span>الوردية الحالية: <strong style="color:var(--purple);font-family:monospace;">${escapeHtml(currentShift.shiftNumber)}</strong></span>
          <span>بدأت الساعة: <strong>${new Date(currentShift.startedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</strong></span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-top:6px;border-top:1px dashed var(--line);padding-top:8px;">
          <div>كاش البداية (الافتتاحي): <strong>${format(currentShift.openingCash)}</strong></div>
          <div>مبيعات الكاش المحصلة: <strong style="color:var(--green, #15803d);">+${format(currentShift.cashSales)}</strong></div>
          <div>مبيعات الفيزا/المحفظة: <strong>${format(currentShift.electronicSales)}</strong></div>
          <div>مرتجعات كاش مسددة: <strong style="color:var(--rose,var(--rose, #be123c));">-${format(currentShift.cashReturns)}</strong></div>
        </div>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;">
          <strong style="font-size:13px;color:var(--ink);">النقدية المتوقع وجودها بالدرج:</strong>
          <strong style="font-size:16px;color:var(--purple);">${format(currentShift.expectedCash)}</strong>
        </div>
      </div>

      <form id="end-shift-form" class="form-stack">
        <label style="font-weight:750;">النقدية الفعلية المعدودة في الدرج الآن (${currency}) *
          <input name="actualCash" id="shift-actual-cash" inputmode="decimal" required placeholder="المبلغ الفعلي بالدرج" style="font-size:16px;font-weight:800;color:var(--ink);">
          <small style="color:var(--muted);font-size:11px;">عِدّ النقدية الموجودة في الدرج بدقة واكتب المبلغ هنا</small>
        </label>

        <div id="shift-variance-preview" style="display:none;padding:10px 14px;border-radius:10px;font-size:12px;font-weight:750;margin:4px 0 10px;"></div>

        <label style="font-weight:750;">المبلغ المورد للشفت القادم / الخزينة (${currency})
          <input name="handoverCash" inputmode="decimal" placeholder="المبلغ المسلم للوردية التالية أو الخزينة" value="0.00">
        </label>

        <label style="font-weight:750;">ملاحظات التقفيل والتسليم (اختياري)
          <input name="notes" maxlength="250" placeholder="مثال: تم تسليم الكاش للزميل أحمد بدون أي عجز">
        </label>

        <div class="modal-actions" style="margin-top:14px;padding:0;">
          <button type="button" class="button button-secondary" data-close-modal>إلغاء</button>
          <button type="submit" class="button button-primary" style="background:#5948d8;border-color:#5948d8;">تأكيد إنهاء الوردية وتقفيل الدرج</button>
        </div>
      </form>
    `;

    const actualInput = modalBody.querySelector('#shift-actual-cash');
    const variancePreview = modalBody.querySelector('#shift-variance-preview');

    actualInput?.addEventListener('input', () => {
      const valStr = actualInput.value.trim();
      if (!valStr || !variancePreview) {
        if (variancePreview) variancePreview.style.display = 'none';
        return;
      }
      try {
        const actualMinor = BigInt(toMinor(valStr, decimals));
        const diff = actualMinor - expectedCashBig;
        variancePreview.style.display = 'block';
        if (diff === 0n) {
          variancePreview.className = 'variance-box variance-match';
          variancePreview.textContent = '✓ رصيد الدرج متطابق تماماً مع المبيعات والنقدية المسجلة.';
        } else if (diff < 0n) {
          variancePreview.className = 'variance-box variance-shortage';
          variancePreview.textContent = `يوجد عجز في الدرج بمقدار: ${format(diff.toString())}`;
        } else {
          variancePreview.className = 'variance-box variance-overage';
          variancePreview.textContent = `توجد زيادة في الدرج بمقدار: +${format(diff.toString())}`;
        }
      } catch {
        variancePreview.style.display = 'none';
      }
    });

    modalBody.querySelector('#end-shift-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const submitBtn = form.querySelector('[type=submit]');
      submitBtn.disabled = true;
      try {
        const formData = new FormData(form);
        const actualMinor = toMinor(formData.get('actualCash') || '0', decimals);
        const handoverMinor = toMinor(formData.get('handoverCash') || '0', decimals);
        const res = await api('/api/shifts/end', {
          method: 'POST',
          body: JSON.stringify({
            shiftId: currentShift.id,
            actualCash: actualMinor,
            handoverCash: handoverMinor,
            notes: formData.get('notes') || '',
          })
        });
        root.innerHTML = '';
        toast(`تم إنهاء الوردية #${res.shift.shiftNumber} وتقفيل الدرج بنجاح`);
        await loadData(state.data.selectedStoreId);
        render();
      } catch (err) {
        toast(err.message, 'error');
        submitBtn.disabled = false;
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}


function bindShifts() {
  document.querySelector('#shifts-start-now-btn')?.addEventListener('click', () => {
    showStartShiftModal();
  });
  document.querySelector('#shifts-end-now-btn')?.addEventListener('click', () => {
    showEndShiftModal();
  });
  document.querySelectorAll('[data-shift-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = btn.dataset.shiftPreset;
      state.shiftPreset = preset;
      const today = new Date().toISOString().slice(0, 10);
      if (preset === 'today') {
        state.shiftFrom = today;
        state.shiftTo = today;
      } else if (preset === 'week') {
        const d = new Date();
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const start = new Date(d.setDate(diff)).toISOString().slice(0, 10);
        state.shiftFrom = start;
        state.shiftTo = today;
      } else if (preset === 'month') {
        const d = new Date();
        const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        state.shiftFrom = start;
        state.shiftTo = today;
      } else {
        state.shiftFrom = '';
        state.shiftTo = '';
      }
      await loadShifts();
    });
  });

  const filterForm = document.querySelector('#shifts-date-filter');
  filterForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(filterForm);
    state.shiftFrom = data.get('from') || '';
    state.shiftTo = data.get('to') || '';
    state.shiftPreset = 'custom';
    await loadShifts();
  });

  document.querySelectorAll('.view-shift-sales-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      showShiftSalesModal(btn.dataset.shiftId, btn.dataset.shiftNumber);
    });
  });
}

function supplierReturnItemModal(purchase, itemId, itemName, returnableQty) {
  supplierModal(
    `<p>إرجاع للتاجر: <strong>${escapeHtml(itemName)}</strong><br>الكمية المتاحة للإرجاع: <strong>${returnableQty} قطعة</strong>. سيتم تقليل رصيد حساب التاجر بسعر الشراء وإخراج القطع من المخزن.</p>
    <label>الكمية المراد إرجاعها
      <input name="quantity" type="number" min="1" max="${returnableQty}" step="1" value="1" required autofocus>
    </label>
    <input type="hidden" name="storeId" value="${state.data.selectedStoreId}">
    <input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`,
    'supplier-return-form',
    `/api/purchases/${purchase.id}/returns`,
    (data) => ({
      idempotencyKey: data.idempotencyKey,
      storeId: data.storeId,
      items: [{ purchaseItemId: itemId, quantity: data.quantity }],
    }),
    'تم تسجيل المرتجع وتحديث المخزون ورصيد التاجر بنجاح'
  );
}

function groupPurchaseItemsByModel(purchase, productsCatalog) {
  const modelMap = new Map();
  for (const item of purchase.items ?? []) {
    const parentProduct = (productsCatalog ?? []).find((p) => p.name === item.productName || (p.variants ?? []).some((v) => v.sku === item.sku));
    const modelKey = parentProduct ? parentProduct.id : (item.productName || item.sku);
    const modelName = parentProduct ? parentProduct.name : item.productName;
    const modelSku = parentProduct ? parentProduct.sku : (item.sku.split('-')[0] || item.sku);

    let group = modelMap.get(modelKey);
    if (!group) {
      group = {
        key: modelKey,
        product: parentProduct,
        name: modelName,
        modelSku,
        items: [],
        totalQuantity: 0n,
        totalReturnable: 0n,
        totalCostMinor: 0n,
        currency: item.unitCost.currency,
        decimals: item.unitCost.decimals,
      };
      modelMap.set(modelKey, group);
    }

    const qty = BigInt(item.quantity);
    const cost = BigInt(item.unitCost.amount);
    group.items.push(item);
    group.totalQuantity += qty;
    group.totalReturnable += BigInt(item.returnableQuantity ?? item.quantity);
    group.totalCostMinor += qty * cost;
  }
  return [...modelMap.values()];
}

function showPurchaseModelVariantsModal(modelGroup, purchase, supplier) {
  const root = getModalRoot();
  const currency = modelGroup.currency;
  const decimals = modelGroup.decimals;

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="purchase-model-breakdown-title">
        <div class="modal-heading">
          <div>
            <span class="eyebrow eyebrow-dark">فاتورة شراء: ${escapeHtml(purchase.invoiceNumber || purchase.id.slice(0, 8))} · التاجر: ${escapeHtml(supplier.name)}</span>
            <h2 id="purchase-model-breakdown-title">${escapeHtml(modelGroup.name)} (كود الموديل: ${escapeHtml(modelGroup.modelSku)})</h2>
            <p>إجمالي المستلم من هذا الموديل: <strong>${modelGroup.totalQuantity} قطعة</strong> · التكلفة: <strong>${money({ amount: modelGroup.totalCostMinor.toString(), currency, decimals })}</strong></p>
          </div>
          <button type="button" class="modal-close" data-close-breakdown>×</button>
        </div>

        <div class="modal-body" style="padding:16px 20px;">
          <div class="table-scroll">
            <table class="invoice-table">
              <thead>
                <tr>
                  <th>اللون والمقاس الفرعي</th>
                  <th>كود الفرع (SKU)</th>
                  <th style="text-align:center;">الكمية المستلمة</th>
                  <th>تكلفة القطعة</th>
                  <th>الإجمالي</th>
                  <th>المتاح للإرجاع</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                ${modelGroup.items.map((item) => {
                  const matchedVariant = modelGroup.product?.variants?.find((v) => v.sku === item.sku);
                  const attrLabel = matchedVariant
                    ? Object.entries(matchedVariant.attributes ?? {}).map(([k, val]) => `${modelGroup.product.options?.find((o) => o.key === k)?.name ?? k}: ${val}`).join(' · ')
                    : item.sku;
                  const canReturn = BigInt(item.returnableQuantity ?? item.quantity) > 0n;
                  const itemLineTotal = (BigInt(item.quantity) * BigInt(item.unitCost.amount)).toString();
                  return `
                    <tr>
                      <td><strong>${escapeHtml(attrLabel || 'النسخة الأساسية')}</strong></td>
                      <td><span class="sku-code">${escapeHtml(item.sku)}</span></td>
                      <td style="text-align:center;"><strong>${item.quantity}</strong> قطعة</td>
                      <td>${money(item.unitCost)}</td>
                      <td class="table-total">${money({ amount: itemLineTotal, currency, decimals })}</td>
                      <td>${item.returnableQuantity} قطعة</td>
                      <td>
                        ${canReturn ? `
                          <button type="button" class="text-action return-supplier-item-btn" data-purchase="${purchase.id}" data-item="${item.id}" data-name="${escapeHtml(attrLabel)}" data-quantity="${item.returnableQuantity}" style="color:var(--rose,var(--rose, #be123c));font-weight:700;">
                            ↩️ إرجاع للتاجر
                          </button>
                        ` : '<span style="color:var(--muted);font-size:11px;">تم الإرجاع</span>'}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="button button-secondary" data-close-breakdown>إغلاق</button>
        </div>
      </section>
    </div>
  `;

  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('[data-close-breakdown]').forEach((b) => b.addEventListener('click', close));

  root.querySelectorAll('.return-supplier-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      close();
      supplierReturnItemModal(purchase, btn.dataset.item, btn.dataset.name, btn.dataset.quantity);
    });
  });
}

function suppliersView() {
  const suppliers = state.data.suppliers;
  const currency = state.data.company.currency;
  const today = new Date().toISOString().slice(0, 10);
  const preset = state.supplierDatePreset ?? 'all';
  const from = state.supplierFrom ?? '';
  const to = state.supplierTo ?? '';

  const filterPurchase = (p) => {
    if (!from && !to) return true;
    const day = p.purchasedAt.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };

  const processedSuppliers = suppliers.map((supplier) => {
    const purchases = supplier.purchases.filter(filterPurchase);
    const totalPurchasedMinor = purchases.reduce((sum, p) => sum + BigInt(p.totalAmount.amount), 0n);
    const totalPaidMinor = purchases.reduce((sum, p) => sum + BigInt(p.paidAmount.amount), 0n);
    const balanceDueMinor = purchases.reduce((sum, p) => sum + BigInt(p.remainingAmount.amount), 0n);
    return {
      ...supplier,
      purchases,
      filteredPurchased: totalPurchasedMinor.toString(),
      filteredPaid: totalPaidMinor.toString(),
      filteredDue: balanceDueMinor.toString(),
    };
  });

  const allFilteredPurchases = processedSuppliers.flatMap((s) => s.purchases);
  const totalPurchasedAll = allFilteredPurchases.reduce((sum, p) => sum + BigInt(p.totalAmount.amount), 0n).toString();
  const totalPaidAll = allFilteredPurchases.reduce((sum, p) => sum + BigInt(p.paidAmount.amount), 0n).toString();
  const totalDueAll = allFilteredPurchases.reduce((sum, p) => sum + BigInt(p.remainingAmount.amount), 0n).toString();
  const amount = (value) => money({ amount: value, currency, decimals: currencyDecimals(currency) });

  const purchaseDisclosure = (supplier, purchase) => {
    const modelGroups = groupPurchaseItemsByModel(purchase, state.data.products);
    const isPaid = !BigInt(purchase.remainingAmount.amount);
    const invoiceLabel = purchase.invoiceNumber || `PUR-${purchase.id.slice(0, 8).toUpperCase()}`;
    const dateFormatted = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(purchase.purchasedAt));
    const totalPieces = modelGroups.reduce((sum, g) => sum + g.totalQuantity, 0n);

    return `
      <details class="purchase-card">
        <summary class="purchase-summary-row">
          <div class="purchase-summary-info">
            <span class="purchase-inv-tag">${icon('box', 14)} ${escapeHtml(invoiceLabel)}</span>
            <span class="purchase-date-pill">${icon('calendar', 14)} ${dateFormatted}</span>
            <span class="purchase-meta-pill">المستلم: <strong>${escapeHtml(purchase.createdByName || 'المسؤول')}</strong></span>
            <span class="purchase-meta-pill"><strong>${totalPieces} قطعة</strong> في ${modelGroups.length} موديل</span>
          </div>
          <div class="purchase-summary-finances">
            <div class="purchase-summary-total">
              <small>إجمالي الفاتورة</small>
              <strong>${money(purchase.totalAmount)}</strong>
            </div>
            <span class="status-pill ${isPaid ? 'status-complete' : 'status-low'}" style="font-weight:700;">
              ${isPaid ? '✓ مسددة بالكامل' : `متبقي ${money(purchase.remainingAmount)}`}
            </span>
            <span class="disclosure-chevron" aria-hidden="true">${icon('chevron', 16)}</span>
          </div>
        </summary>

        <div class="purchase-card-body">
          <div class="purchase-finances-grid">
            <div class="purchase-finance-box">
              <small>المورد / التاجر</small>
              <strong>${escapeHtml(supplier.name)}</strong>
            </div>
            <div class="purchase-finance-box paid">
              <small>المدفوع للتاجر</small>
              <strong>${money(purchase.paidAmount)}</strong>
            </div>
            <div class="purchase-finance-box ${isPaid ? 'paid' : 'due'}">
              <small>المتبقي للتاجر</small>
              <strong>${money(purchase.remainingAmount)}</strong>
            </div>
            <div class="purchase-finance-box">
              <small>المسؤول والملاحظات</small>
              <strong style="font-size:13px;">${escapeHtml(purchase.createdByName || 'المسؤول')}${purchase.notes ? ` · ${escapeHtml(purchase.notes)}` : ''}</strong>
            </div>
          </div>

          <div class="table-scroll">
            <table class="invoice-table" style="margin:4px 0;">
              <thead>
                <tr>
                  <th>الموديل الأساسي / المنتج</th>
                  <th style="text-align:center;">إجمالي الكمية</th>
                  <th>متوسط التكلفة للقطعة</th>
                  <th>إجمالي تكلفة الموديل</th>
                  <th>المقاسات والألوان الفرعية</th>
                </tr>
              </thead>
              <tbody>
                ${modelGroups.map((group) => {
                  const avgCost = group.totalQuantity > 0n ? (group.totalCostMinor / group.totalQuantity).toString() : '0';
                  return `
                    <tr>
                      <td>
                        <div style="display:flex;align-items:center;gap:10px;">
                          <span class="product-avatar" style="width:36px;height:36px;border-radius:10px;background:var(--purple-soft);color:var(--purple);font-size:14px;font-weight:800;display:grid;place-items:center;">
                            ${escapeHtml(group.name.slice(0, 1))}
                          </span>
                          <div>
                            <strong style="font-size:13.5px;color:var(--ink);">${escapeHtml(group.name)}</strong>
                            <div style="font-size:11.5px;color:var(--muted);margin-top:2px;">كود الموديل: <bdi class="sku-code">${escapeHtml(group.modelSku)}</bdi> · <bdi>${group.items.length}</bdi> فرع (مقاس ولون)</div>
                          </div>
                        </div>
                      </td>
                      <td style="text-align:center;">
                        <span class="status-pill status-complete" style="font-size:12.5px;font-weight:800;">${group.totalQuantity} قطعة</span>
                      </td>
                      <td>${money({ amount: avgCost, currency: group.currency, decimals: group.decimals })}</td>
                      <td class="table-total">${money({ amount: group.totalCostMinor.toString(), currency: group.currency, decimals: group.decimals })}</td>
                      <td>
                        <button type="button" class="button button-secondary button-sm view-model-sizes-btn" data-purchase-id="${purchase.id}" data-model-key="${group.key}" style="font-size:11.5px;padding:4px 12px;height:32px;">
                          عرض المقاسات والألوان (${group.items.length})
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          <div class="purchase-footer-bar">
            <div class="purchase-footer-buttons">
              ${!isPaid ? `
                <button type="button" class="button button-primary button-sm pay-purchase" data-purchase="${purchase.id}" data-remaining="${purchase.remainingAmount.amount}">
                  ${icon('wallet', 15)} تسجيل سداد للتاجر
                </button>
              ` : '<span class="status-pill status-complete" style="font-size:12px;font-weight:700;padding:6px 14px;">✓ مسددة بالكامل</span>'}
              <button type="button" class="button button-secondary button-sm print-purchase-labels" data-purchase-id="${purchase.id}">
                طباعة باركود العلب
              </button>
            </div>
            <div class="purchase-footer-meta">
              ${purchase.payments.length ? `<span class="purchase-meta-chip">${icon('check', 13)} تم تسجيل ${purchase.payments.length} دفعة سداد</span>` : ''}
              ${purchase.returns.length ? `<span class="purchase-meta-chip chip-return">${purchase.returns.length} مرتجع</span>` : ''}
            </div>
          </div>

          ${purchase.payments.length || purchase.returns.length ? `
            <details class="compact-disclosure" style="margin-top:8px;border-radius:10px;border:1px solid var(--line);background:var(--surface-soft);">
              <summary style="padding:10px 14px;font-size:12px;font-weight:700;">
                <span>سجل حركات السداد والمرتجعات (${purchase.payments.length + purchase.returns.length} حركة)</span>
                <span class="disclosure-chevron" style="width:26px;height:26px;">${icon('chevron', 14)}</span>
              </summary>
              <div class="disclosure-content" style="padding:4px 14px 12px;">
                ${purchase.payments.map((p) => `
                  <div class="invoice-history-row" style="display:flex;justify-content:space-between;padding:7px 0;font-size:12px;">
                    <span>سداد ${methodLabel(p.paymentMethod)} بواسطة <strong>${escapeHtml(p.createdByName || 'المسؤول')}</strong> · ${new Date(p.paidAt).toLocaleDateString('ar-EG')}</span>
                    <strong style="color:var(--green, #15803d);">${money(p.amount)}</strong>
                  </div>
                `).join('')}
                ${purchase.returns.map((r) => `
                  <div class="invoice-history-row" style="display:flex;justify-content:space-between;padding:7px 0;font-size:12px;color:var(--rose,var(--rose, #be123c));">
                    <span>مرتجع ${escapeHtml(r.returnNumber)} · ${new Date(r.createdAt).toLocaleDateString('ar-EG')}</span>
                    <strong>${money(r.creditAmount)}</strong>
                  </div>
                `).join('')}
              </div>
            </details>
          ` : ''}
        </div>
      </details>
    `;
  };

  return `
    <div class="page-heading-row">
      <div>
        <p class="page-lead">إدارة حسابات التجار ومتابعة فواتير الشراء والاستلام والدفعات حسب التاريخ.</p>
      </div>
      <div>
        <button class="button button-secondary" id="new-supplier">إضافة تاجر</button>
        <button class="button button-primary" id="new-purchase">تسجيل فاتورة شراء</button>
      </div>
    </div>

    <section class="pro-filter-card">
      <div class="pro-filter-row">
        <div class="pro-filter-pills">
          <span style="font-size:12px;font-weight:700;color:var(--muted);display:inline-flex;align-items:center;gap:6px;">
            ${icon('filter', 15)} تصفية الفواتير:
          </span>
          <button type="button" class="pro-filter-pill ${preset === 'all' ? 'active' : ''}" data-sup-preset="all">كل الفواتير</button>
          <button type="button" class="pro-filter-pill ${preset === 'today' ? 'active' : ''}" data-sup-preset="today">اليوم</button>
          <button type="button" class="pro-filter-pill ${preset === 'week' ? 'active' : ''}" data-sup-preset="week">هذا الأسبوع</button>
          <button type="button" class="pro-filter-pill ${preset === 'month' ? 'active' : ''}" data-sup-preset="month">هذا الشهر</button>
        </div>
        <form id="supplier-date-filter" class="pro-date-inputs">
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} من:</label>
            <input type="date" name="from" value="${from}">
          </div>
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} إلى:</label>
            <input type="date" name="to" value="${to}">
          </div>
          <button type="submit" class="button button-primary button-sm" style="height:38px;padding:0 14px;">تطبيق</button>
          ${from || to ? '<button type="button" class="text-action reset-sup-filter" style="font-size:12px;color:var(--rose,var(--rose, #be123c));font-weight:700;">مسح</button>' : ''}
        </form>
      </div>
    </section>

    <div class="inventory-summary" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
      <div class="inventory-summary-card">
        <span class="summary-badge summary-indigo">${icon('users', 18)}</span>
        <div><small>التجار المسجلون</small><strong>${suppliers.length}</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-teal">${icon('bag', 18)}</span>
        <div><small>إجمالي المشتريات ${from || to ? '(في الفترة)' : ''}</small><strong>${amount(totalPurchasedAll)}</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-green" style="background:var(--green-soft);color:var(--green);">${icon('check', 18)}</span>
        <div><small>تم السداد للتجار ${from || to ? '(في الفترة)' : ''}</small><strong style="color:var(--green, #15803d);">${amount(totalPaidAll)}</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-amber">${icon('wallet', 18)}</span>
        <div><small>مستحق للتجار ${from || to ? '(في الفترة)' : ''}</small><strong style="color:${BigInt(totalDueAll) > 0n ? 'var(--rose, #be123c)' : 'inherit'};">${amount(totalDueAll)}</strong></div>
      </div>
    </div>

    ${processedSuppliers.length ? processedSuppliers.map((supplier) => `
      <details class="supplier-card" open>
        <summary class="supplier-summary-bar">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span class="product-avatar" style="width:38px;height:38px;border-radius:10px;background:var(--purple-soft);color:var(--purple);font-size:16px;font-weight:800;display:grid;place-items:center;">
              ${escapeHtml(supplier.name.slice(0, 1))}
            </span>
            <div>
              <h3 style="margin:0;font-size:15px;font-weight:800;color:var(--ink);">${escapeHtml(supplier.name)}</h3>
              <p style="margin:2px 0 0;font-size:12px;color:var(--muted);">${escapeHtml(supplier.phone || 'بدون رقم هاتف')} · ${supplier.purchases.length} فاتورة مسجلة</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-inline-start:8px;flex-wrap:wrap;">
              <span class="purchase-meta-pill">مشتريات: <strong>${amount(supplier.filteredPurchased)}</strong></span>
              <span class="purchase-meta-pill" style="color:var(--green, #15803d);">مدفوع: <strong>${amount(supplier.filteredPaid)}</strong></span>
              <span class="purchase-meta-pill" style="color:${BigInt(supplier.filteredDue) > 0n ? 'var(--rose, #be123c)' : 'var(--green, #15803d)'};">متبقي: <strong>${amount(supplier.filteredDue)}</strong></span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <button type="button" class="button button-secondary button-sm purchase-for-supplier" data-supplier="${supplier.id}" style="font-size:12px;">+ فاتورة شراء جديدة</button>
            <span class="disclosure-chevron" aria-hidden="true">${icon('chevron', 16)}</span>
          </div>
        </summary>
        ${supplier.purchases.length ? `<div class="purchase-list-scroll">${supplier.purchases.map((purchase) => purchaseDisclosure(supplier, purchase)).join('')}</div>` : '<div class="empty-row" style="padding:16px;">لا توجد فواتير شراء في هذه الفترة المحددة لهذا التاجر.</div>'}
      </details>
    `).join('') : `
      <section class="panel empty-chart">
        <div class="empty-illustration">${icon('users', 28)}</div>
        <strong>ابدأ بإضافة أول تاجر</strong>
        <p>سجّل فواتير الشراء، المبالغ المدفوعة، والرصيد المتبقي.</p>
        <button class="button button-primary" id="empty-new-supplier">إضافة تاجر</button>
      </section>
    `}
  `;
}

function profitLossView() {
  document.querySelector('#btn-pl-to-financial-map')?.addEventListener('click', () => {
    state.page = 'financial-map';
    render();
  });
  const today = new Date().toISOString().slice(0, 10);
  const from = state.reportFrom ?? today, to = state.reportTo ?? today;
  const activePlRange = state.plRange ?? (from === today && to === today ? 'today' : 'custom');
  const report = state.report;
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);

  let contentHtml = '';
  if (report) {
    const netSalesAmt = BigInt(report.profitLoss.netSales.amount);
    const cogsAmt = BigInt(report.profitLoss.cogs.amount);
    const grossProfitAmt = BigInt(report.profitLoss.grossProfit.amount);
    const directExpAmt = BigInt(report.profitLoss.directExpenses.amount);
    const monthlyExpAmt = BigInt(report.profitLoss.monthlyExpenses.amount);
    const totalExpAmt = directExpAmt + monthlyExpAmt;
    const netProfitAmt = BigInt(report.profitLoss.operatingProfit.amount);
    const isProfit = netProfitAmt >= 0n;

    contentHtml = `
      <div class="compact-kpi-grid">
        <article class="compact-kpi-card">
          <div class="compact-kpi-top"><span>إجمالي المبيعات</span><span class="kpi-tag kpi-tag-indigo">${report.from} ← ${report.to}</span></div>
          <strong class="compact-kpi-value">${money(report.profitLoss.netSales)}</strong>
          <small>المبيعات المحصلة بعد الخصومات والمرتجعات</small>
        </article>
        <article class="compact-kpi-card">
          <div class="compact-kpi-top"><span>تكلفة البضاعة المباعة</span><span class="kpi-tag kpi-tag-amber">تكلفة الشراء</span></div>
          <strong class="compact-kpi-value">${money(report.profitLoss.cogs)}</strong>
          <small>سعر شراء البضاعة التي تم بيعها</small>
        </article>
        <article class="compact-kpi-card">
          <div class="compact-kpi-top"><span>إجمالي المصروفات</span><span class="kpi-tag kpi-tag-amber">مصروفات المتجر</span></div>
          <strong class="compact-kpi-value">${money({ amount: totalExpAmt.toString(), currency, decimals })}</strong>
          <small>يومية: ${money(report.profitLoss.directExpenses)} · شهرية: ${money(report.profitLoss.monthlyExpenses)}</small>
        </article>
        <article class="compact-kpi-card ${isProfit ? 'compact-kpi-positive' : 'compact-kpi-negative'}" style="border-width:2px;">
          <div class="compact-kpi-top"><span>${isProfit ? 'الأرباح المحققة' : 'الخسائر'}</span><span class="kpi-tag ${isProfit ? 'kpi-tag-green' : 'kpi-tag-red'}">${isProfit ? 'أرباح لك ✓' : 'عجز مالي !'}</span></div>
          <strong class="compact-kpi-value" style="font-size:22px;color:${isProfit ? 'var(--green, #15803d)' : 'var(--rose, #be123c)'};">${money(report.profitLoss.operatingProfit)}</strong>
          <small>${isProfit ? 'المبلغ المتبقي كأرباح بعد خصم تكلفة البضاعة والمصروفات' : 'عجز في الفترة المحددة'}</small>
        </article>
      </div>

      <section class="panel compact-panel" style="margin-top:14px;">
        <div class="panel-heading"><div><h3>ملخص الأرباح بالأرقام (مباشر وسهل)</h3><p>كيف تم حساب الأرباح بعد خصم البضاعة والمصروفات</p></div></div>
        <div class="table-scroll">
          <table class="compact-table">
            <thead>
              <tr><th>البيان</th><th style="text-align:left;">المبلغ</th><th>الحالة</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>إجمالي المبيعات المحصلة</strong></td>
                <td style="text-align:left;" class="table-total">${money(report.profitLoss.netSales)}</td>
                <td><span class="status-pill status-complete">إيراد (+)</span></td>
              </tr>
              <tr>
                <td><strong>يُخصم: تكلفة البضاعة المباعة</strong><br><small>ما دفعناه للتجار في شراء المنتجات المباعة</small></td>
                <td style="text-align:left;" class="table-total">${money(report.profitLoss.cogs)}</td>
                <td><span class="status-pill status-low">خصم (-)</span></td>
              </tr>
              <tr style="background:var(--surface-soft);">
                <td><strong>مجمل الربح التجاري</strong></td>
                <td style="text-align:left;" class="table-total"><strong>${money(report.profitLoss.grossProfit)}</strong></td>
                <td><span>الربح الإجمالي</span></td>
              </tr>
              <tr>
                <td><strong>يُخصم: مصروفات المتجر والتشغيل</strong><br><small>إيجار، فواتير، انتقالات، مصاريف يومية</small></td>
                <td style="text-align:left;" class="table-total">${money({ amount: totalExpAmt.toString(), currency, decimals })}</td>
                <td><span class="status-pill status-low">خصم (-)</span></td>
              </tr>
              <tr style="border-top:2px solid var(--line);background:color-mix(in srgb,${isProfit ? 'var(--brand-soft)' : 'var(--rose-soft)'} 50%,var(--panel));">
                <td><strong style="font-size:15px;">الربح المتبقي لك (${isProfit ? 'أرباح' : 'خسائر'})</strong></td>
                <td style="text-align:left;" class="table-total"><strong style="font-size:17px;color:${isProfit ? 'var(--green, #15803d)' : 'var(--rose, #be123c)'};">${money(report.profitLoss.operatingProfit)}</strong></td>
                <td><span class="status-pill ${isProfit ? 'status-complete' : 'status-low'}">${isProfit ? 'أرباح' : 'خسائر'}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  return `
    <div class="page-heading-row">
      <div>
        <p class="page-lead">ملخص مباشر وواضح لأرباح المتجر بعد خصم تكلفة البضاعة والمصروفات، بدون أي تعقيد.</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button type="button" class="button button-secondary" id="btn-pl-to-financial-map" style="font-weight:700;">
          ${icon('chart', 16)} المسار المالي
        </button>
      </div>
    </div>

    <section class="panel compact-filter-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div class="quick-date-pills">
          <button type="button" class="date-preset-chip ${activePlRange === 'today' ? 'active' : ''}" data-pl-range="today">اليوم</button>
          <button type="button" class="date-preset-chip ${activePlRange === '7d' ? 'active' : ''}" data-pl-range="7d">آخر 7 أيام</button>
          <button type="button" class="date-preset-chip ${activePlRange === '30d' ? 'active' : ''}" data-pl-range="30d">آخر 30 يوم</button>
          <button type="button" class="date-preset-chip ${activePlRange === 'month' ? 'active' : ''}" data-pl-range="month">هذا الشهر</button>
          <button type="button" class="date-preset-chip ${activePlRange === 'year' ? 'active' : ''}" data-pl-range="year">هذا العام</button>
        </div>
        <form id="profit-loss-filter" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:0;font-weight:700;color:var(--ink);">من:
            <input id="report-from" type="date" value="${from}" required style="height:34px;padding:0 8px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-weight:700;">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:0;font-weight:700;color:var(--ink);">إلى:
            <input id="report-to" type="date" value="${to}" required style="height:34px;padding:0 8px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);font-weight:700;">
          </label>
          <button class="button button-primary button-sm" type="submit">تحديث</button>
        </form>
      </div>
    </section>

    <div id="pl-section-content">
      ${contentHtml || '<div class="empty-chart"><div class="empty-illustration"></div><strong>جاري تحميل تقرير الأرباح والخسائر...</strong></div>'}
    </div>
  `;
}

function topProductsView() {
  const stats = state.productStats;
  const vendors = state.supplierStats;
  const today = new Date().toISOString().slice(0, 10);
  const from = state.analyticsFrom ?? (() => { const date = new Date(); date.setUTCDate(date.getUTCDate() - 29); return date.toISOString().slice(0, 10); })();
  const to = state.analyticsTo ?? today;
  const section = state.analyticsSection ?? 'all';
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);
  const analyticsSections = [
    ['all', 'نظرة شاملة'],
    ['top_selling', 'الأكثر مبيعاً وربحية'],
    ['most_purchased', 'الأكثر طلباً من التجار'],
    ['sizes_colors', 'المقاسات والألوان'],
    ['inventory_health', 'المخزون والراكد'],
  ];

  const products = stats?.products ?? [];
  const mostPurchased = stats?.mostPurchasedProducts ?? [];
  const topSizes = stats?.topSizes ?? [];
  const topColors = stats?.topColors ?? [];
  const topVariants = stats?.topVariants ?? [];
  const maxUnitsSold = products.reduce((max, p) => BigInt(p.unitsSold) > max ? BigInt(p.unitsSold) : max, 1n);
  const maxUnitsPurchased = mostPurchased.reduce((max, p) => BigInt(p.unitsOrdered) > max ? BigInt(p.unitsOrdered) : max, 1n);
  const maxSizeUnits = topSizes.reduce((max, s) => BigInt(s.unitsSold) > max ? BigInt(s.unitsSold) : max, 1n);
  const maxColorUnits = topColors.reduce((max, c) => BigInt(c.unitsSold) > max ? BigInt(c.unitsSold) : max, 1n);

  const catalogProducts = state.data.products.filter((p) => p.itemKind === 'PRODUCT' && p.isActive);
  const soldProductIds = new Set(products.filter((p) => BigInt(p.unitsSold) > 0n).map((p) => p.productId));
  const dormantProducts = catalogProducts.filter((p) => !soldProductIds.has(p.id));
  let totalStockUnits = 0n;
  let totalStockCostMinor = 0n;
  let totalStockRetailMinor = 0n;
  for (const p of catalogProducts) {
    for (const v of p.variants.filter((item) => item.isActive)) {
      const q = BigInt(v.quantity);
      if (q > 0n) {
        totalStockUnits += q;
        if (v.wac) totalStockCostMinor += q * BigInt(v.wac.amount);
        totalStockRetailMinor += q * BigInt(v.price.amount);
      }
    }
  }
  const expectedStockProfitMinor = totalStockRetailMinor > totalStockCostMinor ? totalStockRetailMinor - totalStockCostMinor : 0n;

  const mostPurchasedBlock = `
    <section class="panel compact-panel">
      <div class="panel-heading"><div><h3>أكثر الموديلات والمنتجات التي طلبناها من التجار وجاءت</h3><p>إحصائية البضاعة الواردة حسب عدد القطع المطلوبة والمستلم والتكلفة</p></div><span class="status-pill status-complete">${mostPurchased.length} موديل وارد</span></div>
      ${mostPurchased.length ? `<div class="table-scroll analytics-scroll-box"><table class="compact-table"><thead><tr><th>#</th><th>الموديل / المنتج</th><th>كود الموديل</th><th>الكمية المطلوبة</th><th>مرتجع للتاجر</th><th>المستلم بالمخزن</th><th>عدد الفواتير</th><th>متوسط تكلفة القطعة</th><th>إجمالي تكلفة الشراء</th></tr></thead><tbody>${mostPurchased.map((item, idx) => `<tr><td><span class="product-rank ${idx === 0 ? 'product-rank-first' : ''}">${idx + 1}</span></td><td><strong>${escapeHtml(item.name)}</strong></td><td><span class="sku-code">${escapeHtml(item.sku || '—')}</span></td><td><div class="product-units-cell"><strong>${item.unitsOrdered} قطعة</strong><span class="product-units-track"><i style="width:${Math.max(5, Number((BigInt(item.unitsOrdered) * 100n) / maxUnitsPurchased))}%"></i></span></div></td><td>${item.returnedUnits}</td><td><strong>${item.netUnitsReceived}</strong> قطعة</td><td>${item.invoiceCount} فاتورة</td><td>${money(item.avgUnitCost)}</td><td class="table-total">${money(item.totalCost)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد فواتير مشتريات مسجلة في هذه الفترة.</div>'}
    </section>`;

  const topSellingBlock = `
    <section class="panel compact-panel">
      <div class="panel-heading"><div><h3>الموديلات والمنتجات الأكثر مبيعًا وربحية</h3><p>ترتيب الموديلات حسب الكمية المباعة وقيمة المبيعات والأرباح</p></div><span class="status-pill status-complete">${products.length} موديل مباع</span></div>
      ${products.length ? `<div class="table-scroll analytics-scroll-box"><table class="compact-table"><thead><tr><th>#</th><th>الموديل</th><th>الكود</th><th>الكمية المباعة</th><th>الفواتير</th><th>إجمالي المبيعات</th><th>تكلفة المباع</th><th>مجمل الربح</th><th>الهامش</th></tr></thead><tbody>${products.map((product, index) => `<tr><td><span class="product-rank ${index === 0 ? 'product-rank-first' : ''}">${index + 1}</span></td><td><strong>${escapeHtml(product.name)}</strong></td><td><span class="sku-code">${escapeHtml(product.sku || '—')}</span></td><td><div class="product-units-cell"><strong>${product.unitsSold}</strong><span class="product-units-track"><i style="width:${Math.max(5, Number((BigInt(product.unitsSold) * 100n) / maxUnitsSold))}%"></i></span></div></td><td>${product.orderCount}</td><td class="table-total">${money(product.netRevenue)}</td><td>${product.cogs ? money(product.cogs) : '—'}</td><td class="table-total">${product.grossProfit ? money(product.grossProfit) : '—'}</td><td><span class="kpi-tag ${Number(product.marginPercent ?? 0) >= 25 ? 'kpi-tag-green' : 'kpi-tag-indigo'}">${escapeHtml(product.marginPercent ?? '0.0')}%</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد مبيعات في الفترة المحددة.</div>'}
    </section>`;

  const sizesColorsBlock = `
    <div class="analytics-two-col">
      <section class="panel compact-panel">
        <div class="panel-heading"><div><h3>أكثر المقاسات طلبًا ومبيعًا</h3><p>اعرف المقاسات السريعة اللي بتخلص أول بأول عند الطلب من التاجر</p></div></div>
        ${topSizes.length ? `<div class="stat-bars-stack analytics-scroll-box">${topSizes.map((item) => `<div class="stat-bar-row"><div class="stat-bar-label"><span>مقاس <strong>${escapeHtml(item.size)}</strong></span><strong>${item.unitsSold} قطعة</strong></div><div class="stat-bar-track"><i class="bar-fill-indigo" style="width:${Math.max(6, Number((BigInt(item.unitsSold) * 100n) / maxSizeUnits))}%"></i></div></div>`).join('')}</div>` : '<div class="empty-row">تظهر إحصائيات المقاسات فور بيع موديلات بمقاسات.</div>'}
      </section>
      <section class="panel compact-panel">
        <div class="panel-heading"><div><h3>أكثر الألوان طلبًا ومبيعًا</h3><p>الألوان الأكثر حركة وإقبالًا من العملاء</p></div></div>
        ${topColors.length ? `<div class="stat-bars-stack analytics-scroll-box">${topColors.map((item) => `<div class="stat-bar-row"><div class="stat-bar-label"><span>لون <strong>${escapeHtml(item.color)}</strong></span><strong>${item.unitsSold} قطعة</strong></div><div class="stat-bar-track"><i class="bar-fill-teal" style="width:${Math.max(6, Number((BigInt(item.unitsSold) * 100n) / maxColorUnits))}%"></i></div></div>`).join('')}</div>` : '<div class="empty-row">تظهر إحصائيات الألوان فور بيع موديلات بألوان.</div>'}
      </section>
    </div>
    ${topVariants.length ? `<section class="panel compact-panel"><div class="panel-heading"><div><h3>أعلى الفروع (لون × مقاس) مبيعًا</h3><p>أكثر التركيبات الفرعية حركة بالقطعة وإجمالي المبيعات</p></div></div><div class="table-scroll analytics-scroll-box"><table class="compact-table"><thead><tr><th>#</th><th>الموديل</th><th>اللون والمقاس</th><th>كود الفرع (SKU)</th><th>الكمية المباعة</th><th>إجمالي المبيعات</th></tr></thead><tbody>${topVariants.slice(0, 12).map((v, idx) => `<tr><td>${idx + 1}</td><td><strong>${escapeHtml(v.productName)}</strong></td><td><span class="model-chip model-chip-size">${escapeHtml(v.label)}</span></td><td><span class="sku-code">${escapeHtml(v.sku)}</span></td><td><strong>${v.unitsSold}</strong> قطعة</td><td class="table-total">${money(v.netRevenue)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;

  const suppliersBlock = state.data.capabilities.canViewAccounting ? `
    <section class="panel compact-panel">
      <div class="panel-heading"><div><h3>إحصائيات التجار والموردين والمسحوبات</h3><p>إجمالي الطلبات وعدد القطع والمسدد والمتبقي لكل تاجر في الفترة</p></div><span class="status-pill status-complete">${vendors?.suppliers?.length ?? 0} تاجر</span></div>
      ${vendors?.suppliers?.length ? `<div class="table-scroll analytics-scroll-box"><table class="compact-table"><thead><tr><th>#</th><th>اسم التاجر</th><th>عدد الفواتير</th><th>إجمالي القطع المطلوبة</th><th>إجمالي المشتريات</th><th>المدفوع</th><th>المرتجعات</th><th>المتبقي للتاجر</th></tr></thead><tbody>${vendors.suppliers.map((s, idx) => `<tr><td>${idx + 1}</td><td><strong>${escapeHtml(s.name)}</strong></td><td>${s.invoiceCount} فاتورة</td><td><strong>${s.unitsOrdered ?? '—'}</strong> قطعة</td><td class="table-total">${money(s.totalAmount)}</td><td>${s.paidAmount ? money(s.paidAmount) : '—'}</td><td>${s.returnedCredit ? money(s.returnedCredit) : '—'}</td><td>${s.balanceDue && BigInt(s.balanceDue.amount) > 0n ? `<span class="status-pill status-low">${money(s.balanceDue)}</span>` : '<span class="status-pill status-complete">مسدد</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد مشتريات مسجلة من التجار في هذه الفترة.</div>'}
    </section>` : '';

  const inventoryHealthBlock = `
    <section class="panel compact-panel">
      <div class="panel-heading"><div><h3>تقييم المخزون الحالي والأصناف الراكدة</h3><p>القيمة المالية للبضاعة الموجودة على الرف والربح المتوقع منها + الموديلات التي لم تتحرك</p></div></div>
      <div class="compact-kpi-grid">
        <article class="compact-kpi-card"><small>إجمالي القطع بالمخزن الآن</small><strong class="compact-kpi-value">${totalStockUnits} قطعة</strong><small>موزعة على ${catalogProducts.length} موديل أساسي</small></article>
        <article class="compact-kpi-card"><small>تكلفة البضاعة الموجودة بالمخزن</small><strong class="compact-kpi-value">${money({ amount: totalStockCostMinor.toString(), currency, decimals })}</strong><small>بسعر الشراء المرجح (WAC)</small></article>
        <article class="compact-kpi-card"><small>القيمة البيعية للبضاعة بالمخزن</small><strong class="compact-kpi-value">${money({ amount: totalStockRetailMinor.toString(), currency, decimals })}</strong><small>ربح متوقع عند البيع: ${money({ amount: expectedStockProfitMinor.toString(), currency, decimals })}</small></article>
        <article class="compact-kpi-card"><small>موديلات راكدة (لم تُباع في الفترة)</small><strong class="compact-kpi-value">${dormantProducts.length} موديل</strong><small>موديلات بها نواقص: ${state.data.lowStock.length}</small></article>
      </div>
      ${dormantProducts.length ? `<div class="table-scroll analytics-scroll-box"><table class="compact-table"><thead><tr><th>الموديل الراكد في الفترة</th><th>كود الموديل</th><th>الرصيد الحالي بالمخزن</th><th>عدد المقاسات/الألوان</th></tr></thead><tbody>${dormantProducts.slice(0, 10).map((p) => { const activeVars = p.variants.filter((v) => v.isActive); const stock = activeVars.reduce((s, v) => s + BigInt(v.quantity), 0n); return `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td><span class="sku-code">${escapeHtml(p.sku)}</span></td><td><strong>${stock}</strong> قطعة</td><td>${activeVars.length} فرع</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty-row">كل الموديلات المسجلة تحركت وحققت مبيعات في هذه الفترة!</div>'}
    </section>`;

  const selectedContent = section === 'most_purchased' ? mostPurchasedBlock
    : section === 'top_selling' ? topSellingBlock
    : section === 'sizes_colors' ? sizesColorsBlock
    : section === 'suppliers' ? suppliersBlock
    : section === 'inventory_health' ? inventoryHealthBlock
    : `${mostPurchasedBlock}${topSellingBlock}${sizesColorsBlock}${suppliersBlock}${inventoryHealthBlock}`;

  return `<div class="page-heading-row"><div><p class="page-lead">إحصائيات المبيعات، الأرباح، وحركة الموديلات والمقاسات الأكثر طلباً في المتجر.</p></div><button class="button button-secondary button-sm" data-page="reports">فتح الأرباح والخسائر ←</button></div>
    <section class="pro-filter-card">
      <div class="pro-filter-row" style="margin-bottom:12px;">
        <div class="pro-filter-pills">
          <span style="font-size:12px;font-weight:700;color:var(--muted);display:inline-flex;align-items:center;gap:6px;">
            ${icon('calendar', 15)} الفترة الزمنية:
          </span>
          <button type="button" class="pro-filter-pill ${(state.analyticsRange ?? '30d') === '7d' ? 'active' : ''}" data-analytics-range="7d">7 أيام</button>
          <button type="button" class="pro-filter-pill ${(state.analyticsRange ?? '30d') === '30d' ? 'active' : ''}" data-analytics-range="30d">30 يوم</button>
          <button type="button" class="pro-filter-pill ${(state.analyticsRange ?? '30d') === 'month' ? 'active' : ''}" data-analytics-range="month">هذا الشهر</button>
          <button type="button" class="pro-filter-pill ${(state.analyticsRange ?? '30d') === 'year' ? 'active' : ''}" data-analytics-range="year">السنة</button>
        </div>
        <form id="analytics-filter" class="pro-date-inputs">
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} من:</label>
            <input name="from" id="analytics-from" type="date" value="${from}" required>
          </div>
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} إلى:</label>
            <input name="to" id="analytics-to" type="date" value="${to}" required>
          </div>
          <button class="button button-primary button-sm" type="submit" style="height:38px;padding:0 16px;">تطبيق</button>
        </form>
      </div>

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--line);">
        <span style="font-size:12px;font-weight:700;color:var(--muted);display:inline-flex;align-items:center;gap:6px;">
          ${icon('filter', 15)} القسم المعروض:
        </span>
        <div class="pro-filter-pills">
          ${analyticsSections.map(([id, label]) => `<button type="button" class="pro-filter-pill ${section === id ? 'active' : ''}" data-analytics-section="${id}">${label}</button>`).join('')}
        </div>
      </div>
    </section>

    ${!stats || !vendors ? '<section class="panel"><div class="empty-row">جاري تحميل الإحصائيات...</div></section>' : `
      <div class="compact-kpi-grid">
        <article class="compact-kpi-card"><div class="compact-kpi-top"><span>أكثر موديل طلبناه من التجار</span><span class="kpi-tag kpi-tag-teal">الوارد</span></div><strong class="compact-kpi-value">${stats.topPurchasedByUnits ? escapeHtml(stats.topPurchasedByUnits.name) : '—'}</strong><small>${stats.topPurchasedByUnits ? `طلبنا ${stats.topPurchasedByUnits.unitsOrdered} قطعة (صافي ${stats.topPurchasedByUnits.netUnitsReceived})` : 'لا توجد مشتريات في الفترة'}</small></article>
        <article class="compact-kpi-card"><div class="compact-kpi-top"><span>الأكثر مبيعًا للعملاء</span><span class="kpi-tag kpi-tag-indigo">المبيعات</span></div><strong class="compact-kpi-value">${stats.topByUnits ? escapeHtml(stats.topByUnits.name) : '—'}</strong><small>${stats.topByUnits ? `${stats.topByUnits.unitsSold} قطعة مباعة · ${money(stats.topByUnits.netRevenue)}` : 'لا توجد مبيعات في الفترة'}</small></article>
        <article class="compact-kpi-card"><div class="compact-kpi-top"><span>الأعلى ربحية (مجمل ربح)</span><span class="kpi-tag kpi-tag-green">الربح</span></div><strong class="compact-kpi-value">${stats.topByProfit ? escapeHtml(stats.topByProfit.name) : (stats.topByRevenue ? escapeHtml(stats.topByRevenue.name) : '—')}</strong><small>${stats.topByProfit ? `ربح ${money(stats.topByProfit.grossProfit)} (هامش ${stats.topByProfit.marginPercent}%)` : '—'}</small></article>
        <article class="compact-kpi-card"><div class="compact-kpi-top"><span>أكثر مقاس ولون مطلوبين</span><span class="kpi-tag kpi-tag-amber">المقاسات</span></div><strong class="compact-kpi-value">${topSizes[0] ? `مقاس ${escapeHtml(topSizes[0].size)}` : '—'} ${topColors[0] ? `· ${escapeHtml(topColors[0].color)}` : ''}</strong><small>${topSizes[0] ? `${topSizes[0].unitsSold} قطعة لأعلى مقاس` : 'بيانات المقاسات والألوان'}</small></article>
      </div>
      ${selectedContent}
      ${growthForecastWidget(state.growthForecast, currency)}
    `}`;
}
function growthForecastWidget(forecast, currency) {
  if (!forecast) return '';
  const decimals = currencyDecimals(currency);
  const format = (v) => money({ amount: v, currency, decimals });

  const { currentMonth, previousMonth, comparison, forecast: fc, monthlyHistory = [], selectedPeriod } = forecast;
  const isUp = comparison.isGrowth;
  const growthSign = comparison.growthPercent >= 0 ? '+' : '';
  const forecastSign = fc.forecastGrowthPercent >= 0 ? '+' : '';
  const isCurrentMonthView = selectedPeriod?.isCurrent !== false;

  // Year & Period filters
  const currentSysYear = new Date().getFullYear();
  state.growthSelectedYear = state.growthSelectedYear || (selectedPeriod?.year ?? currentSysYear);
  state.growthViewMode = state.growthViewMode || '6m'; // '3m' | '6m' | 'year'

  // Extract available years
  const historyYears = Array.from(new Set([
    currentSysYear - 1,
    currentSysYear,
    currentSysYear + 1,
    ...monthlyHistory.map((m) => m.year)
  ])).sort((a, b) => b - a);

  // Chronological copy for charting
  const chronologicalHistory = [...monthlyHistory].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

  let chartMonths = [];
  if (state.growthViewMode === '3m') {
    chartMonths = chronologicalHistory.slice(-3);
  } else if (state.growthViewMode === '6m') {
    chartMonths = chronologicalHistory.slice(-6);
  } else {
    // Filter by selected year
    chartMonths = chronologicalHistory.filter((m) => m.year === Number(state.growthSelectedYear));
    if (!chartMonths.length) {
      const arMonthsNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      chartMonths = arMonthsNames.map((name, i) => ({
        yearMonth: `${state.growthSelectedYear}-${String(i + 1).padStart(2, '0')}`,
        year: Number(state.growthSelectedYear),
        month: i + 1,
        name: `${name} ${state.growthSelectedYear}`,
        salesCount: 0,
        revenue: '0',
        profit: '0',
        dailyAverage: '0',
        growthPercent: 0,
        isGrowth: true,
        isCurrent: false,
        isSelected: false,
      }));
    }
  }

  // Find max value for bar heights (max height: 140px)
  let maxValMinor = 1n;
  for (const m of chartMonths) {
    const r = BigInt(m.revenue || '0');
    const p = BigInt(m.profit || '0');
    if (r > maxValMinor) maxValMinor = r;
    if (p > maxValMinor) maxValMinor = p;
  }
  const maxValNum = Number(maxValMinor) || 1;

  return `
    <section class="panel compact-panel" style="margin-top:20px;">
      <!-- شريط أدوات الرسم البياني والفلاتر -->
      <div class="growth-toolbar" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1px solid var(--line);padding-bottom:14px;">
        <div>
          <h3 style="font-size:16px;font-weight:850;color:var(--ink);margin:0;display:flex;align-items:center;gap:8px;">
            ${icon('chart', 18)} الرسم البياني وإحصائيات التقدم والنمو الشهري
          </h3>
          <p style="margin:3px 0 0;font-size:12px;color:var(--muted);">
            تتبع بصري لحركة المبيعات والأرباح عبر الشهور والسنوات، مع إمكانية استعراض وتدقيق أي فترة.
          </p>
        </div>

        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <!-- فلاتر المدة -->
          <div class="pro-filter-pills" style="margin:0;">
            <button type="button" class="pro-filter-pill ${state.growthViewMode === '3m' ? 'active' : ''}" id="growth-view-3m">آخر 3 شهور</button>
            <button type="button" class="pro-filter-pill ${state.growthViewMode === '6m' ? 'active' : ''}" id="growth-view-6m">آخر 6 شهور</button>
            <button type="button" class="pro-filter-pill ${state.growthViewMode === 'year' ? 'active' : ''}" id="growth-view-year">سنة كاملة</button>
          </div>

          <!-- اختيار السنة -->
          <div style="display:inline-flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:750;color:var(--muted);">السنة:</label>
            <select id="growth-year-select" class="pro-select" style="font-size:12.5px;padding:4px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);font-weight:800;color:var(--ink);cursor:pointer;">
              ${historyYears.map((yr) => `
                <option value="${yr}" ${Number(state.growthSelectedYear) === yr ? 'selected' : ''}>سنة ${yr}</option>
              `).join('')}
            </select>
          </div>

          <!-- اختيار الشهر للتدقيق -->
          <div style="display:inline-flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:750;color:var(--muted);">تحليل شهر:</label>
            <select id="growth-month-picker" class="pro-select" style="font-size:12.5px;padding:4px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);font-weight:800;color:var(--ink);cursor:pointer;">
              ${monthlyHistory.map((m) => `
                <option value="${m.yearMonth}" ${m.isSelected ? 'selected' : ''}>
                  ${m.name} ${m.isCurrent ? '(الحالي)' : ''}
                </option>
              `).join('')}
            </select>
          </div>
        </div>
      </div>

      <!-- الرسم البياني التفاعلي للأعمدة المزدوجة -->
      <div class="growth-chart-wrapper">
        <div class="growth-chart-legend">
          <div class="growth-legend-items">
            <span class="legend-item legend-sales">
              <span class="legend-bullet" style="background:#5948d8;"></span>
              إجمالي المبيعات
            </span>
            <span class="legend-item legend-profit">
              <span class="legend-bullet" style="background:var(--green, #15803d);"></span>
              مجمل الربح التجاري
            </span>
          </div>
          <small class="legend-hint">اضغط على أي عمود لاستعراض وتحليل تفاصيل ذلك الشهر</small>
        </div>

        <div class="growth-chart-stage">
          ${chartMonths.map((m) => {
            const revNum = Number(m.revenue || '0');
            const profitNum = Number(m.profit || '0');
            const revHeight = revNum > 0 ? Math.max(16, Math.round((revNum / maxValNum) * 160)) : 6;
            const profitHeight = profitNum > 0 ? Math.max(10, Math.round((profitNum / maxValNum) * 160)) : 6;
            const isSelectedMonth = m.isSelected || (m.year === currentMonth.year && m.month === currentMonth.month);

            return `
              <div class="growth-col-item ${isSelectedMonth ? 'growth-col-active' : ''}" data-chart-ym="${m.yearMonth}" title="${escapeHtml(m.name)}: مبيعات ${format(m.revenue)} | أرباح ${format(m.profit)}">
                <div class="growth-col-bars">
                  <!-- عمود المبيعات -->
                  <div class="growth-bar-wrap">
                    <span class="growth-bar-val growth-val-sales">${revNum > 0 ? format(m.revenue) : ''}</span>
                    <div class="growth-bar-elem growth-bar-sales" style="height:${revHeight}px;"></div>
                  </div>
                  <!-- عمود الربح -->
                  <div class="growth-bar-wrap">
                    <span class="growth-bar-val growth-val-profit">${profitNum > 0 ? format(m.profit) : ''}</span>
                    <div class="growth-bar-elem growth-bar-profit" style="height:${profitHeight}px;"></div>
                  </div>
                </div>
                <div class="growth-col-label">
                  <strong>${m.name.split(' ')[0]}</strong>
                  <small>${m.year}</small>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- بطاقات المقارنة والتحليل -->
      <div class="growth-forecast-grid" style="margin-top:16px;">
        <div class="growth-forecast-card ${isUp ? 'card-growth' : 'card-decline'}">
          <div class="growth-card-header">
            <span class="growth-card-title">${escapeHtml(currentMonth.name)} مقارنة بـ ${escapeHtml(previousMonth.name)}</span>
            <span class="status-pill ${isUp ? 'status-complete' : 'status-low'}" style="font-size:12px;font-weight:800;">
              ${isUp ? 'نمو' : 'تراجع'} (${growthSign}${comparison.growthPercent}%)
            </span>
          </div>
          <div class="growth-headline">
            ${isUp
              ? `مبيعات ${escapeHtml(currentMonth.name)} أعلى من ${escapeHtml(previousMonth.name)} بنسبة <span style="color:var(--green, #15803d);font-weight:900;">${growthSign}${comparison.growthPercent}%</span>`
              : `مبيعات ${escapeHtml(currentMonth.name)} أقل من ${escapeHtml(previousMonth.name)} بنسبة <span style="color:var(--rose, #be123c);font-weight:900;">${comparison.growthPercent}%</span>`
            }
          </div>
          <div class="growth-stats-row">
            <span>مبيعات الشهر: <strong>${format(currentMonth.revenue)}</strong></span>
            <span>مجمل الربح: <strong>${format(currentMonth.profit)}</strong></span>
            <span>الشهر السابق: <strong>${format(previousMonth.revenue)}</strong></span>
            <span>المتوسط اليومي: <strong>${format(currentMonth.dailyAverage)}</strong></span>
            <span>الفواتير: <strong>${currentMonth.salesCount}</strong></span>
          </div>
        </div>

        <div class="growth-forecast-card card-projected">
          <div class="growth-card-header">
            <span class="growth-card-title">${isCurrentMonthView ? `توقعات شهر ${escapeHtml(fc.nextMonthName)}` : `خلاصة أداء شهر ${escapeHtml(currentMonth.name)}`}</span>
            <span class="status-pill status-complete" style="font-size:12px;font-weight:800;">${isCurrentMonthView ? escapeHtml(fc.statusText) : 'شهر مكتمل ومؤرشف'}</span>
          </div>
          <div class="growth-headline">
            ${isCurrentMonthView ? `
              متوقع الشهر القادم مبيعات بنسبة <span style="color:var(--purple);font-weight:900;">${forecastSign}${fc.forecastGrowthPercent}%</span> (مبيعات تقديرية: <span style="color:var(--purple);font-weight:900;">${format(fc.projectedRevenue)}</span>)
            ` : `
              إجمالي مبيعات الشهر حققت <span style="color:var(--purple);font-weight:900;">${format(currentMonth.revenue)}</span> بعدد <span style="font-weight:900;">${currentMonth.salesCount}</span> فاتورة مكتملة.
            `}
          </div>
          <div class="growth-stats-row">
            ${isCurrentMonthView ? `
              <span>توقع ختام هذا الشهر: <strong>${format(currentMonth.projectedMonthEnd)}</strong></span>
              <span>الوتيرة اليومية المطلوبة: <strong>${format(fc.dailyExpectedPace)} / يوم</strong></span>
            ` : `
              <span>مجمل الأرباح المحققة: <strong>${format(currentMonth.profit)}</strong></span>
              <span>متوسط المبيعات اليومية: <strong>${format(currentMonth.dailyAverage)}</strong></span>
            `}
          </div>
        </div>
      </div>
    </section>
  `;
}

async function loadGrowthForecast(year = null, month = null) {
  const storeId = state.data?.selectedStoreId;
  const query = new URLSearchParams({ storeId });
  if (year && month) {
    query.set('year', year);
    query.set('month', month);
  }
  const key = `${storeId}:${year || 'cur'}:${month || 'cur'}`;
  if (state.growthForecastKey === key && state.growthForecast) return state.growthForecast;
  try {
    state.growthForecastKey = key;
    const result = await api(`/api/reports/growth-forecast?${query.toString()}`);
    state.growthForecast = result;
    render();
    return result;
  } catch (e) {
    state.growthForecastKey = null;
    return null;
  }
}

async function loadFinancialMap(preset = state.financialMapRange || 'all') {
  const storeId = state.data?.selectedStoreId;
  const today = new Date().toISOString().slice(0, 10);
  let from = '', to = '';

  if (preset === 'today') {
    from = today; to = today;
  } else if (preset === 'week') {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 7); from = d.toISOString().slice(0, 10); to = today;
  } else if (preset === 'month') {
    const d = new Date(); d.setUTCDate(1); from = d.toISOString().slice(0, 10); to = today;
  }

  const query = new URLSearchParams({ storeId });
  if (from) query.set('from', from);
  if (to) query.set('to', to);

  const key = `${storeId}:${from}:${to}`;
  if (state.financialMapKey === key && state.financialMap) return state.financialMap;

  try {
    state.financialMapKey = key;
    state.financialMapRange = preset;
    const result = await api(`/api/reports/financial-map?${query.toString()}`);
    state.financialMap = result;
    render();
    return result;
  } catch (e) {
    state.financialMapKey = null;
    toast(e.message, 'error');
    return null;
  }
}

function financialMapView() {
  const mapData = state.financialMap;
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);
  const format = (value) => money({ amount: value, currency, decimals });

  if (!mapData) {
    void loadFinancialMap();
    return `<div class="panel empty-chart" style="padding:60px 20px;"><div class="empty-illustration">${icon('chart', 32)}</div><strong>جاري إعداد المسار المالي وتدفق الأرباح...</strong><p>يتم تجميع كافة عمليات البيع وسداد التجار والمصروفات بالترتيب الزمني.</p></div>`;
  }

  const { summary, timeline, range } = mapData;
  const activePreset = state.financialMapRange || 'all';

  return `
    <div class="page-heading-row">
      <div>
        <p class="page-lead">المسار المالي: تتبع تدفق الأرباح خطوة بخطوة بالترتيب الزمني من أول عملية وصولاً للمكسب الحالي.</p>
      </div>
      <div>
        <button type="button" class="button button-secondary" data-page="reports">عرض تقرير الأرباح والخسائر ←</button>
      </div>
    </div>

    <section class="pro-filter-card" style="margin-bottom:18px;">
      <div class="pro-filter-row">
        <div class="pro-filter-pills">
          <span style="font-size:12px;font-weight:700;color:var(--muted);display:inline-flex;align-items:center;gap:6px;">
            ${icon('filter', 15)} تصفية الحركات:
          </span>
          <button type="button" class="pro-filter-pill ${activePreset === 'all' ? 'active' : ''}" data-fm-preset="all">كل الحركات</button>
          <button type="button" class="pro-filter-pill ${activePreset === 'today' ? 'active' : ''}" data-fm-preset="today">اليوم</button>
          <button type="button" class="pro-filter-pill ${activePreset === 'week' ? 'active' : ''}" data-fm-preset="week">هذا الأسبوع</button>
          <button type="button" class="pro-filter-pill ${activePreset === 'month' ? 'active' : ''}" data-fm-preset="month">هذا الشهر</button>
        </div>
        <form id="fm-date-filter" class="pro-date-inputs">
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} من:</label>
            <input type="date" name="from" value="${range?.from ?? ''}">
          </div>
          <div class="pro-input-wrap">
            <label>${icon('calendar', 14)} إلى:</label>
            <input type="date" name="to" value="${range?.to ?? ''}">
          </div>
          <button type="submit" class="button button-primary button-sm" style="height:38px;padding:0 14px;">تطبيق</button>
        </form>
      </div>
    </section>

    <div class="fm-card-grid" style="grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px;">
      <div class="fm-kpi-card">
        <small>المبيعات المحصلة (+)</small>
        <strong style="color:var(--green, #15803d);font-size:18px;">+${format(summary.totalSales)}</strong>
        <small style="color:var(--muted);">مجمل ربح البضاعة: ${format(summary.totalGrossProfit)}</small>
      </div>
      <div class="fm-kpi-card">
        <small>سداد دفعات الموردين (-)</small>
        <strong style="color:var(--rose, #be123c);font-size:18px;">-${format(summary.totalSupplierPaid)}</strong>
        <small style="color:var(--muted);">حركة نقدية لتسوية المديونية</small>
      </div>
      <div class="fm-kpi-card">
        <small>المصروفات المسددة (-)</small>
        <strong style="color:var(--rose, #be123c);font-size:18px;">-${format(summary.totalExpensesPaid)}</strong>
        <small style="color:var(--muted);">إيجار ومصروفات تشغيلية مؤكدة</small>
      </div>
      ${(() => {
        const opMinor = BigInt(summary.operatingProfit ?? '0');
        const isOpProfit = opMinor >= 0n;
        return `
          <div class="fm-kpi-card" style="border-right:3px solid ${isOpProfit ? 'var(--green, #15803d)' : 'var(--rose,var(--rose, #be123c))'};${!isOpProfit ? 'background:rgba(190,18,60,0.03);' : ''}">
            <small style="color:${isOpProfit ? 'var(--green, #15803d)' : 'var(--rose,var(--rose, #be123c))'};font-weight:750;">${isOpProfit ? 'صافي الأرباح التشغيلية (+)' : 'النتيجة التشغيلية (عجز / خسائر -)'}</small>
            <strong style="color:${isOpProfit ? 'var(--green, #15803d)' : 'var(--rose,var(--rose, #be123c))'};font-size:19px;">${isOpProfit ? '+' : ''}${format(summary.operatingProfit)}</strong>
            <small style="color:var(--muted);">${isOpProfit ? 'أرباح محققة من النشاط التجاري' : 'عجز نتيجة زيادة المصروفات عن أرباح المبيعات'}</small>
          </div>
        `;
      })()}
      ${(() => {
        const cashMinor = BigInt(summary.netCashFlow ?? summary.realizedCashProfit ?? '0');
        const isCashPositive = cashMinor >= 0n;
        return `
          <div class="fm-kpi-card" style="border-right:3px solid ${isCashPositive ? 'var(--blue, #2563eb)' : 'var(--rose,var(--rose, #be123c))'};">
            <small style="color:${isCashPositive ? 'var(--blue, #2563eb)' : 'var(--rose,var(--rose, #be123c))'};font-weight:750;">صافي السيولة النقدية (الكاش)</small>
            <strong style="color:${isCashPositive ? 'var(--green, #15803d)' : 'var(--rose, #be123c)'};font-size:19px;">${isCashPositive ? '+' : ''}${format(summary.netCashFlow ?? summary.realizedCashProfit)}</strong>
            <small style="color:var(--muted);">المحصل كاش - المدفوع للتجار والمصاريف</small>
          </div>
        `;
      })()}
    </div>

    <div class="pro-info-banner" style="background:var(--surface-soft);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:18px;">
      <strong style="color:var(--ink);font-size:13.5px;display:block;margin-bottom:5px;">
        بيان توضيحي لنتيجة النشاط والفرق بين الأرباح والخسائر وحركة السيولة:
      </strong>
      <p style="font-size:12px;color:var(--ink-soft);margin:0;line-height:1.7;">
        • <strong>لماذا يوجد عجز تشغيلي (${format(summary.operatingProfit)})؟</strong><br>
        مجمل ربح البضاعة التي تم بيعها فعلياً بلغ <strong>${format(summary.totalGrossProfit)}</strong>، بينما المصروفات والالتزامات المسددة بلغت <strong>${format(summary.totalExpensesPaid)}</strong> (تشمل إيجار 4,000 ج.م ومصروفات تشغيل وكهرباء). بما أن المصروفات في هذه الفترة أعلى من أرباح البضاعة المباعة، فالنتيجة هي <strong>عجز / خسارة بقيمة ${format(summary.operatingProfit)}</strong> وتتحول تلقائياً إلى ربح مع بيع المزيد من البضاعة لتغطية المصروفات.<br>
        • <strong>صافي حركة السيولة (${format(summary.netCashFlow ?? summary.realizedCashProfit)}):</strong> يمثل حركة النقدية الفعلية داخل الدرج والخزينة (المقبوض من العملاء مخصوماً منه المسدد للتجار والمصروفات).
      </p>
    </div>

    <section class="panel compact-panel">
      <div class="panel-heading">
        <div>
          <h3 style="font-size:16px;font-weight:800;color:var(--ink);">المسار المالي خطوة بخطوة (كيف وصلت لهذا الرقم)</h3>
          <p>تسلسل الحركات المالية بالترتيب الزمني (من البداية حتى الآن) مع إظهار رصيدك في كل خطوة وصولاً للمبلغ الحالي (${timeline.length} حركة مسجلة)</p>
        </div>
      </div>

      ${timeline.length ? `
        <div class="table-scroll analytics-scroll-box" style="max-height:650px;">
          <table class="compact-table fm-timeline-table">
            <thead>
              <tr>
                <th style="width:40px;text-align:center;">#</th>
                <th>نوع الحركة</th>
                <th>البيان والتفاصيل</th>
                <th>التاريخ والوقت</th>
                <th>المسؤول والطرف</th>
                <th style="text-align:left;">المبلغ</th>
                <th style="text-align:center;">الرصيد بعد الحركة</th>
              </tr>
            </thead>
            <tbody>
              ${timeline.map((item, index) => {
                const isSale = item.type === 'SALE';
                const isSupplier = item.type === 'SUPPLIER_PAYMENT';
                const isExpense = item.type === 'EXPENSE';
                const badgeClass = isSale ? 'fm-sale' : isSupplier ? 'fm-supplier' : isExpense ? 'fm-expense' : 'fm-return';
                const badgeIcon = isSale ? "+" : isSupplier ? "-" : isExpense ? "-" : "±";
                const flowColor = isSale ? 'var(--green, #15803d)' : 'var(--rose, #be123c)';
                const flowSign = isSale ? '+' : '-';
                const flowAmount = isSale ? item.amountIn : item.amountOut;
                const formattedDate = formatDateTime(item.timestamp);

                return `
                  <tr>
                    <td style="text-align:center;font-weight:800;color:var(--muted);font-size:12px;">#${index + 1}</td>
                    <td>
                      <span class="fm-badge ${badgeClass}">
                        <span>${badgeIcon}</span> ${escapeHtml(item.category)}
                      </span>
                    </td>
                    <td>
                      <strong style="font-size:13.5px;color:var(--ink);">${escapeHtml(item.title)}</strong>
                      <div style="font-size:11.5px;color:var(--muted);margin-top:2px;">${escapeHtml(item.details)}</div>
                    </td>
                    <td>
                      <span style="font-size:12px;color:var(--ink-soft);font-weight:600;">${formattedDate}</span>
                    </td>
                    <td>
                      <strong>${escapeHtml(item.party)}</strong>
                      <div style="font-size:11px;color:var(--muted);">بواسطة: ${escapeHtml(item.actor)}</div>
                    </td>
                    <td style="text-align:left;">
                      <strong style="font-size:14px;color:${flowColor};">${flowSign} ${format(flowAmount)}</strong>
                    </td>
                    <td style="text-align:center;">
                      <span class="running-chip">
                        الرصيد: ${format(item.runningCash)}
                      </span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-chart" style="padding:40px 15px;">
          <div class="empty-illustration">${icon('chart', 28)}</div>
          <strong>لا توجد حركات مالية في الفترة المحددة</strong>
          <p>سجل مبيعات أو مصروفات أو سداد فواتير تجار لتظهر في المسار المالي.</p>
        </div>
      `}
    </section>
  `;
}

function expensesView() {
  const items = state.data.monthlyExpenses ?? [];
  const period = state.data.monthlyPeriod || { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const allExpenses = state.data.expenses ?? [];
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);
  const format = (value) => money({ amount: value, currency, decimals });

  const currentYear = Number(period.year);
  const currentMonth = Number(period.month);
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();

  const arabicMonths = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];
  const monthName = arabicMonths[currentMonth - 1] || `شهر ${currentMonth}`;

  // Month navigation calculation
  let prevYear = currentYear, prevMonth = currentMonth - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  let nextYear = currentYear, nextMonth = currentMonth + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  const now = new Date();
  const isActualCurrentMonth = (currentYear === now.getFullYear() && currentMonth === (now.getMonth() + 1));

  // Available months list
  const availablePeriods = state.data.availableMonthlyPeriods || [];
  const allMonthsMap = new Map();
  allMonthsMap.set(`${currentYear}-${currentMonth}`, { year: currentYear, month: currentMonth });
  allMonthsMap.set(`${now.getFullYear()}-${now.getMonth() + 1}`, { year: now.getFullYear(), month: now.getMonth() + 1 });
  availablePeriods.forEach((p) => allMonthsMap.set(`${p.year}-${p.month}`, { year: Number(p.year), month: Number(p.month) }));
  for (let i = 1; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    allMonthsMap.set(`${d.getFullYear()}-${d.getMonth() + 1}`, { year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  const sortedMonths = Array.from(allMonthsMap.values()).sort((a, b) => (b.year - a.year) || (b.month - a.month));

  // Filter direct expenses by current selected month
  const monthPrefix = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const currentMonthExpenses = allExpenses.filter((e) => (e.date || '').startsWith(monthPrefix));

  const confirmed = items.filter((item) => item.actual);
  const due = confirmed.reduce((sum, item) => sum + BigInt(item.actual.remainingAmount.amount), 0n).toString();
  const accrued = confirmed.reduce((sum, item) => sum + BigInt(item.actual.amount.amount), 0n).toString();
  const totalPaid = confirmed.reduce((sum, item) => sum + BigInt(item.actual.paidAmount.amount), 0n).toString();
  const totalDirectExpenses = currentMonthExpenses.reduce((sum, item) => sum + BigInt(item.amount.amount), 0n).toString();

  return `
    <div class="page-heading-row">
      <div>
        <h2 style="margin:0;font-size:20px;font-weight:800;color:var(--ink);">المصروفات والالتزامات</h2>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <button type="button" class="button button-secondary" id="new-monthly-obligation">+ إضافة التزام (إيجار/مرتبات)</button>
        <button type="button" class="button button-primary" id="new-expense">+ إضافة مصروف (كهرباء/نثريات)</button>
      </div>
    </div>

    <!-- شريط أرشيف وتصفح الشهور -->
    <div class="panel" style="padding:10px 16px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;background:var(--surface);">
      <div style="display:flex;align-items:center;gap:10px;">
        
        <div>
          <span style="font-size:12px;color:var(--muted);font-weight:700;">سجل شهر:</span>
          <strong style="font-size:15px;color:var(--ink);margin-inline-start:4px;">${monthName} ${currentYear}</strong>
          ${isActualCurrentMonth ? '<span class="status-pill status-complete" style="font-size:11px;margin-inline-start:8px;padding:2px 8px;">الشهر الجاري</span>' : '<span class="status-pill status-low" style="font-size:11px;margin-inline-start:8px;padding:2px 8px;">أرشيف سابق</span>'}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <button type="button" class="button button-secondary button-sm" id="btn-prev-month" data-year="${prevYear}" data-month="${prevMonth}" style="font-size:12px;padding:4px 12px;">
          ◀ السابق
        </button>
        <select id="expense-month-picker" class="field-select" style="height:32px;font-size:12.5px;font-weight:700;padding:0 8px;border-radius:8px;">
          ${sortedMonths.map((p) => `
            <option value="${p.year}-${p.month}" ${p.year === currentYear && p.month === currentMonth ? 'selected' : ''}>
              ${arabicMonths[p.month - 1]} ${p.year}
            </option>
          `).join('')}
        </select>
        <button type="button" class="button button-secondary button-sm" id="btn-next-month" data-year="${nextYear}" data-month="${nextMonth}" style="font-size:12px;padding:4px 12px;">
          التالي ▶
        </button>
        ${!isActualCurrentMonth ? `
          <button type="button" class="button button-secondary button-sm" id="btn-current-month" data-year="${now.getFullYear()}" data-month="${now.getMonth() + 1}" style="font-size:12px;color:var(--purple);border-color:var(--purple);padding:4px 10px;">
            العودة للشهر الحالي
          </button>
        ` : ''}
      </div>
    </div>

    <!-- ملخص أرقام الشهر -->
    <div class="inventory-summary" style="grid-template-columns: repeat(4, minmax(0, 1fr));margin-bottom:20px;">
      <div class="inventory-summary-card">
        <span class="summary-badge summary-indigo">${icon('chart', 18)}</span>
        <div><small>إجمالي الإيجار والالتزامات</small><strong>${format(accrued)}</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-teal" style="background:var(--green-soft);color:var(--green);">${icon('check', 18)}</span>
        <div><small>المسدد من الالتزامات</small><strong style="color:var(--green, #15803d);">${format(totalPaid)}</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-amber">${icon('wallet', 18)}</span>
        <div><small>الباقي غير المسدد</small><strong style="color:${BigInt(due) > 0n ? 'var(--rose, #be123c)' : 'var(--green, #15803d)'};">${format(due)}</strong></div>
      </div>
      <div class="inventory-summary-card">
        <span class="summary-badge summary-amber" style="background:var(--rose-soft);color:var(--rose);">${icon('wallet', 18)}</span>
        <div><small>المصروفات المباشرة المسجلة</small><strong style="color:var(--rose, #be123c);">${format(totalDirectExpenses)}</strong></div>
      </div>
    </div>

    <!-- قائمة الالتزامات بنمط بطاقات التجار المصغرة -->
    <div style="margin-bottom:14px;">
      <h3 style="margin:0 0 10px;font-size:15px;font-weight:800;color:var(--ink);">الالتزامات الشهرية</h3>
    </div>

    ${items.length ? items.map((item) => {
      if (item.actual) {
        const actualAmountMinor = BigInt(item.actual.amount.amount);
        const remainingMinor = BigInt(item.actual.remainingAmount.amount);
        const dailyMinor = actualAmountMinor / BigInt(daysInMonth);
        const suggestedMinor = remainingMinor < dailyMinor ? remainingMinor : dailyMinor;
        const suggestedFormatted = decimalPrice({ amount: suggestedMinor.toString(), decimals });

        return `
          <details class="supplier-card" style="margin-bottom:12px !important;">
            <summary class="supplier-summary-bar" style="padding:12px 18px;">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <span class="product-avatar" style="width:36px;height:36px;border-radius:10px;background:var(--purple-soft);color:var(--purple);font-size:15px;font-weight:800;display:grid;place-items:center;">
                  ${escapeHtml(item.name.slice(0, 1))}
                </span>
                <div>
                  <h3 style="margin:0;font-size:15px;font-weight:800;color:var(--ink);">${escapeHtml(item.name)}</h3>
                  <p style="margin:2px 0 0;font-size:11.5px;color:var(--muted);">${escapeHtml(item.category)} · موعد الاستحقاق: يوم ${item.dueDay} في الشهر</p>
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-inline-start:6px;flex-wrap:wrap;">
                  <span class="purchase-meta-pill">الإيجار: <strong>${money(item.actual.amount)}</strong></span>
                  <span class="purchase-meta-pill" style="background:var(--green-soft);color:var(--green);border:1px solid var(--green);">المقسومة (اليوم): <strong>${suggestedFormatted} ${currency}</strong></span>
                  <span class="purchase-meta-pill" style="color:var(--green, #15803d);">مسدد: <strong>${money(item.actual.paidAmount)}</strong></span>
                  <span class="purchase-meta-pill" style="color:${remainingMinor > 0n ? 'var(--rose, #be123c)' : 'var(--green, #15803d)'};">متبقي: <strong>${money(item.actual.remainingAmount)}</strong></span>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                ${remainingMinor > 0n ? `
                  <button type="button" class="button button-primary button-sm pay-monthly"
                          data-actual="${item.actual.id}"
                          data-remaining="${item.actual.remainingAmount.amount}"
                          data-daily="${suggestedFormatted}"
                          data-name="${escapeHtml(item.name)}"
                          style="font-size:12px;padding:5px 16px;font-weight:700;">
                    سداد
                  </button>
                ` : `<span class="status-pill status-complete" style="font-size:11.5px;padding:3px 8px;">✓ مسدد بالكامل</span>`}
                ${item.actual.payments.length ? `<span class="disclosure-chevron" aria-hidden="true">${icon('chevron', 14)}</span>` : ''}
              </div>
            </summary>
            ${item.actual.payments.length ? `
              <div class="obligation-payments-box">
                <div class="obligation-payments-head">
                  <span>سجل الدفعات المسددة لهذا الشهر (${item.actual.payments.length} دفعة):</span>
                  <span class="status-pill status-complete">${money(item.actual.paidAmount)} تم سداده</span>
                </div>
                <div class="obligation-payments-scroll">
                  ${item.actual.payments.map((p) => `
                    <div class="obligation-payment-row">
                      <div class="obligation-payment-info">
                        <span class="payment-badge-chip">${p.method === 'CASH_DRAWER' ? 'درج النقدية' : p.method === 'CASH_SAFE' ? 'الخزينة' : 'تحويل بنكي'}</span>
                        <span style="color:var(--muted);">${new Date(p.paidAt).toLocaleDateString('ar-EG')}</span>
                        ${p.referenceNumber ? `<span style="font-weight:600;color:var(--ink);">${escapeHtml(p.referenceNumber)}</span>` : ''}
                      </div>
                      <strong class="obligation-payment-amount">${money(p.amount)}</strong>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </details>
        `;
      }

      const pastAmountDec = item.suggestedPastAmount ? decimalPrice(item.suggestedPastAmount) : '';
      return `
        <details class="supplier-card" style="margin-bottom:12px !important;">
          <summary class="supplier-summary-bar" style="padding:12px 18px;">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
              <span class="product-avatar" style="width:36px;height:36px;border-radius:10px;background:var(--purple-soft);color:var(--purple);font-size:15px;font-weight:800;display:grid;place-items:center;">
                ${escapeHtml(item.name.slice(0, 1))}
              </span>
              <div>
                <h3 style="margin:0;font-size:15px;font-weight:800;color:var(--ink);">${escapeHtml(item.name)}</h3>
                <p style="margin:2px 0 0;font-size:11.5px;color:var(--muted);">${escapeHtml(item.category)} · موعد الاستحقاق: يوم ${item.dueDay} في الشهر</p>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-inline-start:6px;flex-wrap:wrap;">
                <span class="purchase-meta-pill" style="color:var(--muted);">لم يتم تحديد قيمة شهر ${monthName}</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <button type="button" class="button button-primary button-sm confirm-monthly"
                      data-obligation="${item.id}"
                      data-name="${escapeHtml(item.name)}"
                      data-suggested="${pastAmountDec}"
                      style="font-size:12px;padding:5px 14px;font-weight:700;">
                تحديد قيمة الشهر
              </button>
            </div>
          </summary>
        </details>
      `;
    }).join('') : `
      <section class="panel empty-chart" style="padding:28px;">
        <div class="empty-illustration">${icon('wallet', 28)}</div>
        <strong>لا توجد التزامات مسجلة بعد</strong>
        <p>أضف التزامك (مثل إيجار المحل أو المرتبات) لتسجيله ومتابعته وسداده بسهولة.</p>
        <button type="button" class="button button-primary" id="empty-new-monthly-obligation" style="margin-top:12px;">+ إضافة التزام جديد</button>
      </section>
    `}

    <!-- سجل المصروفات المباشرة (مثل الكهرباء والصيانة) -->
    <section class="panel compact-panel" style="margin-top:24px;">
      <div class="panel-heading" style="padding:12px 18px;">
        <div>
          <h3 style="font-size:15px;font-weight:800;color:var(--ink);margin:0;">سجل المصروفات المباشرة لشهر ${monthName} (${currentMonthExpenses.length} مصروف)</h3>
          <p style="margin:2px 0 0;font-size:11.5px;color:var(--muted);">المصروفات التي تم تسجيلها (كهرباء، فواتير، مستلزمات، صيانة...).</p>
        </div>
        <button type="button" class="button button-primary button-sm" id="new-expense-table-btn" style="font-size:12px;padding:4px 14px;">+ إضافة مصروف جديد</button>
      </div>

      ${currentMonthExpenses.length ? `
        <div class="table-scroll">
          <table class="compact-table">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>التصنيف</th>
                <th>البيان والملاحظات</th>
                <th>طريقة الدفع</th>
                <th style="text-align:left;">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              ${currentMonthExpenses.map((expense) => `
                <tr>
                  <td><strong>${escapeHtml(expense.date)}</strong></td>
                  <td><span class="status-pill status-complete" style="font-size:11.5px;font-weight:700;">${escapeHtml(expense.category)}</span></td>
                  <td><strong>${escapeHtml(expense.notes || 'مصروف مباشر')}</strong>${expense.referenceNumber ? ` · <span class="sku-code">${escapeHtml(expense.referenceNumber)}</span>` : ''}</td>
                  <td>${expense.paymentMethod === 'CASH_DRAWER' ? 'درج النقدية' : expense.paymentMethod === 'CASH_SAFE' ? 'الخزينة' : 'تحويل بنكي'}</td>
                  <td style="text-align:left;" class="table-total" style="color:var(--rose, #be123c);font-weight:800;">${money(expense.amount)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="empty-row" style="padding:22px;text-align:center;font-size:12.5px;color:var(--muted);">
          لا توجد مصروفات مباشرة مسجلة في شهر ${monthName}. اضغط على «+ إضافة مصروف» لتسجيل فاتورة كهرباء أو صيانة.
        </div>
      `}
    </section>
  `;
}

function posView() {
  const selectedCategory = state.posCategory ?? null;
  const query = state.query.trim().toLowerCase();
  const products = state.data.products
    .filter((product) => product.isActive)
    .filter((product) => !selectedCategory || product.categoryId === selectedCategory)
    .map((product) => ({ ...product, matrix: extractProductMatrix(product), variants: product.variants.filter((variant) => variant.isActive) }))
    .filter((product) => product.variants.length && (!query || `${product.name} ${product.sku} ${product.brand ?? ''} ${product.variants.map((variant) => `${variant.sku} ${variant.barcode ?? ''} ${Object.values(variant.attributes ?? {}).join(' ')}`).join(' ')}`.toLowerCase().includes(query)));
  const totalMinor = state.cart.reduce((sum, item) => sum + BigInt(item.price.amount) * BigInt(item.quantity), 0n);
  const currency = state.data.company.currency;
  const decimals = state.cart[0]?.price.decimals ?? currencyDecimals(currency);
  const total = { amount: totalMinor.toString(), currency, decimals };
  const activeShift = state.data.activeShift;
  const mustStartShift = state.data.user.role !== 'OWNER' && !activeShift;
  const shiftBanner = activeShift ? `
    <div class="pos-shift-banner pos-shift-banner-active" style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 1px 3px rgba(0,0,0,.04);">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#10b981;"></span>
        <div>
          <span style="font-size:13px;color:var(--ink);font-weight:750;">الوردية نشطة: <strong style="color:var(--purple);font-family:monospace;">${escapeHtml(activeShift.shiftNumber)}</strong></span>
          <span style="font-size:11.5px;color:var(--muted);margin-right:8px;">(بدأت: ${new Date(activeShift.startedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })})</span>
        </div>
      </div>
      <button type="button" id="pos-end-shift-now-btn" class="button button-sm button-secondary" style="font-weight:750;padding:6px 14px;color:var(--purple);border-color:var(--purple);">
        إنهاء الوردية وتسليم النقدية
      </button>
    </div>
  ` : `
    <div class="pos-shift-banner pos-shift-banner-inactive" style="background:var(--surface);border:1.5px dashed #059669;border-radius:12px;padding:12px 18px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 1px 3px rgba(0,0,0,.04);">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;"></span>
        <div>
          <strong style="font-size:13px;color:var(--ink);display:block;">لم يتم بدء الوردية بعد</strong>
          <span style="font-size:11.5px;color:var(--muted);">${mustStartShift ? 'نقطة البيع مقفولة — ابدأ الوردية أولاً لتتمكن من تنفيذ أي عملية بيع' : 'اضغط هنا لإدخال عهدة البداية لتسجيل الحضور وتفعيل الكاشير'}</span>
        </div>
      </div>
      <button type="button" id="pos-start-shift-now-btn" class="button button-sm" style="background:#059669;border-color:#059669;color:#fff;font-weight:750;padding:6px 16px;box-shadow:0 2px 6px rgba(5,150,105,.2);">
        بدء الوردية الآن
      </button>
    </div>
  `;
  return `<div class="pos-layout"><section class="pos-catalog">${shiftBanner}<div class="pos-page-title"><div><span class="eyebrow eyebrow-dark">نقطة البيع</span><h2>عملية بيع جديدة</h2><p>${mustStartShift ? 'ابدأ الوردية أولاً لإتاحة اختيار المنتجات وإتمام البيع.' : 'ابحث باسم الموديل أو الكود ثم اختر اللون والمقاس المطلوب بضغطة واحدة.'}</p></div><div class="pos-shortcut">${icon('scan', 18)}<span>نقطة بيع الفرع</span><kbd>F2</kbd></div></div><label class="pos-search">${icon('search', 20)}<input id="pos-search" placeholder="${mustStartShift ? 'ابدأ الوردية أولاً لتفعيل نقطة البيع...' : 'ابحث باسم الموديل أو كود الموديل أو الباركود'}" value="${escapeHtml(state.query)}" ${mustStartShift ? 'disabled' : 'autofocus'}><kbd>Enter</kbd></label><div class="pos-category-row"><button type="button" class="category-chip ${!selectedCategory ? 'active' : ''}" data-pos-cat="">كل الموديلات <span>${state.data.products.filter((p) => p.isActive).length}</span></button>${state.data.categories.map((category) => { const count = state.data.products.filter((p) => p.isActive && p.categoryId === category.id).length; return `<button type="button" class="category-chip ${selectedCategory === category.id ? 'active' : ''}" data-pos-cat="${category.id}">${escapeHtml(category.name)} <span>${count}</span></button>`; }).join('')}</div><div class="pos-products" style="${mustStartShift ? 'opacity:0.55;' : ''}">${products.map((product, index) => { const stock = product.variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n); const allSamePrice = new Set(product.variants.map((variant) => variant.price.amount)).size === 1; const price = allSamePrice ? money(product.variants[0].price) : 'أسعار متعددة'; const subMeta = product.matrix.isMatrix ? `${product.matrix.rawColors.length ? `${product.matrix.rawColors.length} لون` : ''}${product.matrix.rawColors.length && product.matrix.rawSizes.length ? ' · ' : ''}${product.matrix.sizeRangeLabel}` : `${product.variants.length} نسخة`; return `<button class="pos-product-card" data-pick-product="${product.id}" ${(mustStartShift || (product.itemKind === 'PRODUCT' && stock <= 0n)) ? 'disabled' : ''}><span class="pos-product-art art-${index % 6}">${icon('box', 27)}</span><span class="pos-product-info"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku)} · ${escapeHtml(subMeta)} · ${product.itemKind === 'SERVICE' ? 'خدمة' : `${stock} متاح`}</small><b>${price}</b></span><span class="add-product-mark">${icon('plus', 16)}</span></button>`; }).join('') || `<div class="pos-no-products"><div class="empty-illustration">${icon('search', 27)}</div><strong>${state.data.products.length ? 'مفيش منتج مطابق للبحث' : 'أضف منتجاتك الأول'}</strong><button class="text-action" data-page="products">الذهاب للمنتجات ←</button></div>`}</div></section><aside class="cart-panel"><div class="cart-header"><div><span class="eyebrow eyebrow-dark">الفاتورة الحالية</span><h3>فاتورة جديدة</h3></div><button id="clear-cart" class="text-action" ${state.cart.length ? '' : 'disabled'}>مسح الكل</button></div><div class="cart-store-name">${icon('store', 16)} ${escapeHtml(state.data.stores.find((store) => store.id === state.data.selectedStoreId)?.name ?? '')}<span class="live-dot"></span></div><div class="cart-items" id="cart-items">${mustStartShift ? `<div class="cart-empty"><span class="cart-empty-icon">${icon('clock', 23)}</span><strong>يجب بدء الوردية أولاً</strong><p>لا يمكن إجراء أي عملية بيع قبل تسجيل بدء الوردية واستلام الدرج.</p><button type="button" id="cart-start-shift-btn" class="button button-primary button-sm" style="margin-top:10px;background:#059669;border-color:#059669;">بدء الوردية الآن</button></div>` : state.cart.length ? state.cart.map((item) => `<div class="cart-line"><div class="cart-line-main"><span class="cart-line-art">${icon('box', 16)}</span><div><strong>${escapeHtml(item.name)}</strong><small>${money(item.price)} × ${item.quantity}</small></div><button class="remove-line" data-remove="${item.variantId}" aria-label="حذف">×</button></div><div class="cart-line-bottom"><div class="quantity-control"><button data-qty="${item.variantId}" data-delta="-1">−</button><span>${item.quantity}</span><button data-qty="${item.variantId}" data-delta="1">+</button></div><strong>${money({ ...item.price, amount: (BigInt(item.price.amount) * BigInt(item.quantity)).toString() })}</strong></div></div>`).join('') : `<div class="cart-empty"><span class="cart-empty-icon">${icon('bag', 23)}</span><strong>الفاتورة لسه فاضية</strong><p>اختار منتج من القائمة أو امسح الباركود عشان تضيفه.</p></div>`}</div><div class="cart-footer"><div class="cart-totals"><div><span>عدد القطع</span><strong>${state.cart.reduce((sum, item) => sum + item.quantity, 0)}</strong></div><div><span>الخصم</span><strong>${money({ ...total, amount: '0' })}</strong></div><div class="cart-grand-total"><span>الإجمالي المستحق</span><strong>${money(total)}</strong></div></div><div class="payment-heading"><span>طريقة الدفع</span></div><div class="payment-methods">${[['CASH', 'نقدي', '◉'], ['CARD', 'بطاقة', '▤'], ['MOBILE', 'محفظة', '▦']].map(([method, label, mark]) => `<button class="payment-method ${state.paymentMethod === method ? 'selected' : ''}" data-method="${method}" ${mustStartShift ? 'disabled' : ''}><span>${mark}</span>${label}</button>`).join('')}</div><button id="checkout-button" class="button button-primary checkout-button" ${(!mustStartShift && state.cart.length && !state.isSaving) ? '' : 'disabled'}><span>${mustStartShift ? 'ابدأ الوردية أولاً' : 'إتمام البيع'}</span><strong>${money(total)}</strong></button><p class="secure-checkout">${icon('wallet', 14)} العملية هتتحفظ مباشرة في قاعدة بيانات المتجر</p></div></div>`;
}

function supplierModal(html, formId, endpoint, convert = (data) => data, successMessage = 'تم حفظ الحركة في سجل التاجر') {
  const root = getModalRoot();
  const isPayment = formId === 'monthly-payment-form' || formId === 'purchase-payment-form';
  const submitText = isPayment ? 'تأكيد السداد' : 'حفظ';
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card ${formId === 'purchase-form' ? 'product-variants-modal' : ''}" role="dialog" aria-modal="true"><div class="modal-heading"><h2>${formId === 'supplier-form' ? 'إضافة تاجر' : formId === 'purchase-form' ? 'تسجيل فاتورة شراء من تاجر (نظام الموديل والألوان والمقاسات)' : formId === 'expense-form' ? 'تسجيل مصروف' : formId === 'return-form' ? 'تسجيل مرتجع مرتبط بالفاتورة' : formId === 'supplier-return-form' ? 'تسجيل مرتجع للمورد' : formId === 'monthly-obligation-form' ? 'إضافة التزام شهري' : formId === 'monthly-actual-form' ? 'تأكيد المصروف الفعلي' : 'تسجيل سداد'}</h2><button class="modal-close" data-close-modal aria-label="إغلاق">×</button></div><form id="${formId}" class="form-stack modal-form">${html}<div class="modal-actions"><button type="button" class="button button-secondary" data-close-modal>إلغاء</button><button type="submit" class="button button-primary">${submitText}</button></div></form></section></div>`;
  root.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  // Modal backdrop click dismissal disabled: tapping outside does NOT discard the popup.
  root.querySelector(`#${formId}`).addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true;
    try {
      const data = convert(Object.fromEntries(new FormData(event.currentTarget)));
      await api(endpoint, { method: 'POST', body: JSON.stringify(data) });
      root.innerHTML = '';
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
      toast(successMessage);
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
}

function bindFinancialMap() {
  document.querySelectorAll('[data-fm-preset]').forEach((btn) => btn.addEventListener('click', () => {
    state.financialMapRange = btn.dataset.fmPreset;
    state.financialMapKey = null;
    void loadFinancialMap(btn.dataset.fmPreset);
  }));

  document.querySelector('#fm-date-filter')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const from = fd.get('from');
    const to = fd.get('to');
    const storeId = state.data?.selectedStoreId;
    const query = new URLSearchParams({ storeId });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    state.financialMapRange = 'custom';
    state.financialMapKey = `${storeId}:${from}:${to}`;
    void api(`/api/reports/financial-map?${query.toString()}`).then((res) => {
      state.financialMap = res;
      render();
    }).catch((err) => toast(err.message, 'error'));
  });
}

function bindExpenses() {
  bindMonthlyExpenses();

  const openExpenseModal = () => {
    const decimals = currencyDecimals(state.data.company.currency);
    const date = new Date().toISOString().slice(0, 10);
    supplierModal(`<label>تصنيف المصروف<select name="categoryCode"><option value="UTILITIES">مرافق وفواتير (كهرباء/ماء/إنترنت)</option><option value="RENT">إيجار المحل</option><option value="TRANSPORT">نقل ومواصلات</option><option value="MAINTENANCE">صيانة</option><option value="SUPPLIES">مستلزمات تشغيل</option><option value="OTHER">مصروفات أخرى</option></select></label><div class="form-grid"><label>المبلغ (${state.data.company.currency})<input name="amount" inputmode="decimal" required autofocus></label><label>تاريخ المصروف<input name="expenseDate" type="date" value="${date}" required></label></div><label>طريقة الدفع<select name="paymentMethod"><option value="CASH_DRAWER">درج النقدية</option><option value="CASH_SAFE">الخزينة</option><option value="BANK_TRANSFER">تحويل بنكي</option></select></label><label>ملاحظات وبيان المصروف (كهرباء، بوفيه...)<input name="notes" maxlength="500" placeholder="مثال: فاتورة كهرباء"></label><label>رقم مرجعي (اختياري)<input name="referenceNumber" maxlength="80"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'expense-form', '/api/expenses', (data) => ({ ...data, amount: toMinor(data.amount, decimals) }), 'تم تسجيل المصروف بنجاح وخصمه من الخزينة والمكسب');
  };

  document.querySelector('#new-expense')?.addEventListener('click', openExpenseModal);
  document.querySelector('#new-expense-table-btn')?.addEventListener('click', openExpenseModal);
}

function bindSuppliers() {
  document.querySelector('#new-supplier, #empty-new-supplier')?.addEventListener('click', () => supplierModal('<label>اسم التاجر<input name="name" required minlength="2" maxlength="120"></label><label>رقم الهاتف<input name="phone" maxlength="40" type="tel"></label><label>ملاحظات<input name="notes" maxlength="500"></label>', 'supplier-form', '/api/suppliers'));
  const purchase = (supplierId = '') => {
    if (!state.data.suppliers.length) { toast('أضف التاجر الأول قبل تسجيل الفاتورة', 'error'); return; }
    const products = state.data.products.filter((product) => product.itemKind === 'PRODUCT' && product.isActive && product.variants.some((variant) => variant.isActive));
    if (!products.length) { toast('أضف المنتجات قبل تسجيل فاتورة شراء', 'error'); return; }

    let groupIndex = 0;
    const selections = new Map();
    const currency = state.data.company.currency;
    const decimals = currencyDecimals(currency);

    const groupMarkup = (index) => `
      <section class="invoice-model-card" data-purchase-group="${index}">
        <div class="invoice-model-head">
          <div style="display:flex;align-items:center;gap:12px;flex:1;flex-wrap:wrap;">
            <label style="min-width:240px;margin:0;"><strong>الموديل أو الصنف:</strong>
              <select name="purchaseProduct_${index}" style="margin-top:4px;">
                ${products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)} (${escapeHtml(product.sku)})</option>`).join('')}
              </select>
            </label>
            <label style="min-width:160px;margin:0;"><strong>سعر الشراء للقطعة (${currency}):</strong>
              <input name="purchaseCost_${index}" inputmode="decimal" required placeholder="مثال: 450" style="margin-top:4px;">
            </label>
          </div>
          <button type="button" class="text-action remove-purchase-group" style="color:var(--rose,var(--rose, #be123c));">× حذف الموديل</button>
        </div>
        <div class="invoice-model-body">
          <div class="purchase-variant-grid"></div>
        </div>
      </section>
    `;

    const modalHtml = `
      <div style="margin-bottom:14px;">
        <h2 style="font-size:18px;margin-bottom:4px;">فاتورة شراء واستلام بضاعة</h2>
        <p style="color:var(--muted);font-size:12px;margin:0;">سجل استلام بضاعة من التاجر وتحديث أرصدة المقاسات فوراً</p>
      </div>

      <div class="form-grid" style="margin-bottom:14px;">
        <label>التاجر / المورد
          <select name="supplierId">
            ${state.data.suppliers.map((supplier) => `<option value="${supplier.id}" ${supplier.id === supplierId ? 'selected' : ''}>${escapeHtml(supplier.name)}</option>`).join('')}
          </select>
        </label>
        <label>رقم فاتورة التاجر (اختياري)
          <input name="invoiceNumber" maxlength="80" placeholder="يُنشأ رقم تلقائي إذا تُرك فارغاً">
        </label>
      </div>

      <div id="purchase-lines">${groupMarkup(groupIndex)}</div>

      <button id="add-purchase-product" type="button" class="button button-secondary" style="margin-bottom:14px;">
        + إضافة موديل آخر لنفس الفاتورة
      </button>

      <!-- Clean Payment & Summary Box -->
      <div class="invoice-summary-box">
        <div class="invoice-summary-row grand-total">
          <span>إجمالي الفاتورة:</span>
          <strong id="invoice-grand-total-text">0.00 ${currency}</strong>
        </div>

        <div style="display:grid;gap:6px;">
          <label><strong>طريقة السداد:</strong></label>
          <div class="product-kind-toggle" id="payment-choice-toggle" style="margin-bottom:0;">
            <button type="button" class="product-kind-btn active" data-pay-mode="FULL_CASH">دفع كاش كامل</button>
            <button type="button" class="product-kind-btn" data-pay-mode="FULL_CREDIT">⏳ آجل بالكامل (على الحساب)</button>
            <button type="button" class="product-kind-btn" data-pay-mode="PARTIAL">دفع جزء والباقي آجل</button>
          </div>
        </div>

        <div class="form-grid" id="payment-details-row">
          <label id="paid-amount-wrap">المبلغ المدفوع الآن (${currency})
            <input name="paidAmount" id="purchase-paid-input" inputmode="decimal" value="0" required>
          </label>
          <label>خزينة / وسيلة الدفع
            <select name="paymentMethod">
              <option value="CASH">درج النقدية (كاش)</option>
              <option value="BANK_TRANSFER">تحويل بنكي</option>
              <option value="CARD">بطاقة بنكية</option>
              <option value="MOBILE">محفظة إلكترونية</option>
            </select>
          </label>
        </div>

        <div class="invoice-summary-row balance-due">
          <span>المتبقي لحساب التاجر (آجل):</span>
          <strong id="invoice-remaining-text">0.00 ${currency}</strong>
        </div>

        <label style="margin-top:6px;">ملاحظات الفاتورة (اختياري)
          <input name="notes" maxlength="500" placeholder="ملاحظات أو رقم إذن الاستلام...">
        </label>
      </div>

      <input type="hidden" name="totalAmount" id="purchase-total-hidden" value="0">
      <input type="hidden" name="storeId" value="${state.data.selectedStoreId}">
      <input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">
    `;

    supplierModal(modalHtml, 'purchase-form', '/api/purchases', (data) => {
      const items = [];
      for (const [key, quantity] of Object.entries(data)) {
        if (!key.startsWith('purchaseQty_') || Number(quantity) <= 0) continue;
        const match = key.match(/^purchaseQty_(\d+)_([0-9a-f-]+)$/i);
        if (!match) continue;
        const [, index, variantId] = match;
        const unitCostVal = data[`purchaseCost_${index}`];
        if (!unitCostVal) throw new Error('يرجى كتابة سعر الشراء للقطعة لكل موديل في الفاتورة');
        items.push({ variantId, quantity, unitCost: toMinor(unitCostVal, decimals) });
      }
      if (!items.length) throw new Error('حدد كمية لتركيبة واحدة على الأقل في الفاتورة');
      return {
        ...data,
        items,
        totalAmount: toMinor(data.totalAmount, decimals),
        paidAmount: toMinor(data.paidAmount, decimals),
      };
    });

    const root = getModalRoot();
    const form = root.querySelector('#purchase-form');
    let currentPayMode = 'FULL_CASH';

    const updatePurchaseTotal = () => {
      let totalMinor = 0n;
      for (const [index, selection] of selections) {
        if (!selection.size) continue;
        const costInput = form.elements.namedItem(`purchaseCost_${index}`);
        const unitCost = costInput ? costInput.value.trim() : '';
        if (!unitCost) continue;
        try {
          const minor = BigInt(toMinor(unitCost, decimals));
          for (const quantity of selection.values()) totalMinor += minor * BigInt(quantity);
        } catch {}
      }

      const totalFormatted = decimalPrice({ amount: totalMinor.toString(), decimals });
      form.querySelector('#purchase-total-hidden').value = totalFormatted;
      form.querySelector('#invoice-grand-total-text').textContent = `${totalFormatted} ${currency}`;

      const paidInput = form.querySelector('#purchase-paid-input');
      if (currentPayMode === 'FULL_CASH') {
        paidInput.value = totalFormatted;
        paidInput.readOnly = true;
      } else if (currentPayMode === 'FULL_CREDIT') {
        paidInput.value = '0';
        paidInput.readOnly = true;
      } else {
        paidInput.readOnly = false;
      }

      let paidMinor = 0n;
      try {
        paidMinor = BigInt(toMinor(paidInput.value || '0', decimals));
      } catch {}

      const remainingMinor = totalMinor > paidMinor ? totalMinor - paidMinor : 0n;
      const remainingFormatted = decimalPrice({ amount: remainingMinor.toString(), decimals });
      form.querySelector('#invoice-remaining-text').textContent = `${remainingFormatted} ${currency}`;
    };

    // Pay Mode Toggle
    form.querySelectorAll('[data-pay-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        form.querySelectorAll('[data-pay-mode]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentPayMode = btn.dataset.payMode;
        updatePurchaseTotal();
      });
    });

    form.querySelector('#purchase-paid-input')?.addEventListener('input', () => {
      let totalMinor = 0n;
      try { totalMinor = BigInt(toMinor(form.querySelector('#purchase-total-hidden').value || '0', decimals)); } catch {}
      let paidMinor = 0n;
      try { paidMinor = BigInt(toMinor(form.querySelector('#purchase-paid-input').value || '0', decimals)); } catch {}
      const rem = totalMinor > paidMinor ? totalMinor - paidMinor : 0n;
      form.querySelector('#invoice-remaining-text').textContent = `${decimalPrice({ amount: rem.toString(), decimals })} ${currency}`;
    });

    const renderGroup = (section) => {
      const index = section.dataset.purchaseGroup;
      const product = products.find((item) => item.id === section.querySelector(`[name="purchaseProduct_${index}"]`).value);
      const groupSelection = selections.get(index) ?? new Map();
      selections.set(index, groupSelection);
      const matrix = extractProductMatrix(product);
      const variants = matrix.activeVariants;

      if (matrix.isMatrix && matrix.colors.length >= 1 && matrix.sizes.length >= 1) {
        section.querySelector('.purchase-variant-grid').innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <span style="font-size:12px;font-weight:700;color:var(--muted);">
              مقاسات الموديل (${matrix.colors.length} ألوان × ${matrix.sizes.length} مقاسات):
            </span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="date-preset-chip" data-fill-serie="standard">+1 سيريه كامل (12 زوج)</button>
              <button type="button" class="date-preset-chip" data-fill-serie="one">+1 لكل المقاسات</button>
              <button type="button" class="date-preset-chip" data-clear-all style="color:var(--rose,var(--rose, #be123c));">تصفير</button>
            </div>
          </div>
          <div class="table-scroll">
            <table class="simple-quantity-matrix">
              <thead>
                <tr>
                  <th style="text-align:right;">اللون \\ المقاس</th>
                  ${matrix.sizes.map((s) => `<th>مقاس ${escapeHtml(s)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${matrix.colors.map((color) => `
                  <tr>
                    <td style="text-align:right;font-weight:700;">${escapeHtml(color)}</td>
                    ${matrix.sizes.map((size) => {
                      const variant = matrix.matrixMap.get(`${color}:::${size}`);
                      if (!variant) return '<td style="color:var(--muted);">-</td>';
                      const q = groupSelection.get(variant.id) ?? 0;
                      return `
                        <td>
                          <input type="number" min="0" step="1"
                            data-qty-variant="${variant.id}"
                            data-qty-size="${escapeHtml(size)}"
                            name="purchaseQty_${index}_${variant.id}"
                            value="${q}">
                        </td>
                      `;
                    }).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      } else {
        section.querySelector('.purchase-variant-grid').innerHTML = `
          <div class="table-scroll">
            <table class="simple-quantity-matrix">
              <thead>
                <tr>
                  <th style="text-align:right;">الصنف</th>
                  <th>الكمية المستلمة</th>
                </tr>
              </thead>
              <tbody>
                ${variants.map((v) => {
                  const q = groupSelection.get(v.id) ?? 0;
                  const label = formatVariantAttributes(product, v.attributes, product.name);
                  return `
                    <tr>
                      <td style="text-align:right;"><strong>${escapeHtml(label)}</strong> (${escapeHtml(v.sku)})</td>
                      <td>
                        <input type="number" min="0" step="1"
                          data-qty-variant="${v.id}"
                          name="purchaseQty_${index}_${v.id}"
                          value="${q}">
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;
      }
    };

    renderGroup(root.querySelector('[data-purchase-group]'));
    updatePurchaseTotal();

    // Listeners for invoice lines
    root.querySelector('#purchase-lines')?.addEventListener('input', (e) => {
      if (e.target.matches('[name^="purchaseCost_"]')) updatePurchaseTotal();
      const qtyInput = e.target.closest('[data-qty-variant]');
      if (qtyInput) {
        const section = qtyInput.closest('[data-purchase-group]');
        const idx = section.dataset.purchaseGroup;
        const varId = qtyInput.dataset.qtyVariant;
        const qty = Math.max(0, Math.floor(Number(qtyInput.value) || 0));
        const groupSel = selections.get(idx) ?? new Map();
        if (qty > 0) groupSel.set(varId, qty);
        else groupSel.delete(varId);
        selections.set(idx, groupSel);
        updatePurchaseTotal();
      }
    });

    root.querySelector('#purchase-lines')?.addEventListener('change', (e) => {
      if (e.target.matches('[name^="purchaseProduct_"]')) {
        const section = e.target.closest('[data-purchase-group]');
        const idx = section.dataset.purchaseGroup;
        selections.set(idx, new Map());
        renderGroup(section);
        updatePurchaseTotal();
      }
    });

    root.querySelector('#purchase-lines')?.addEventListener('click', (e) => {
      const section = e.target.closest('[data-purchase-group]');
      if (!section) return;
      const idx = section.dataset.purchaseGroup;
      const product = products.find((item) => item.id === section.querySelector(`[name="purchaseProduct_${idx}"]`)?.value);
      const matrix = product ? extractProductMatrix(product) : { sizes: [] };

      if (e.target.closest('.remove-purchase-group')) {
        if (root.querySelectorAll('[data-purchase-group]').length > 1) {
          selections.delete(idx);
          section.remove();
          updatePurchaseTotal();
        } else {
          toast('يجب أن تحتوي الفاتورة على موديل واحد على الأقل', 'error');
        }
        return;
      }

      if (e.target.closest('[data-fill-serie="standard"]')) {
        const groupSel = selections.get(idx) ?? new Map();
        section.querySelectorAll('[data-qty-variant]').forEach((inp) => {
          const w = computeSerieWeight(matrix.sizes, inp.dataset.qtySize, 'standard');
          const next = (Number(inp.value) || 0) + w;
          inp.value = String(next);
          groupSel.set(inp.dataset.qtyVariant, next);
        });
        selections.set(idx, groupSel);
        updatePurchaseTotal();
      }

      if (e.target.closest('[data-fill-serie="one"]')) {
        const groupSel = selections.get(idx) ?? new Map();
        section.querySelectorAll('[data-qty-variant]').forEach((inp) => {
          const next = (Number(inp.value) || 0) + 1;
          inp.value = String(next);
          groupSel.set(inp.dataset.qtyVariant, next);
        });
        selections.set(idx, groupSel);
        updatePurchaseTotal();
      }

      if (e.target.closest('[data-clear-all]')) {
        selections.set(idx, new Map());
        section.querySelectorAll('[data-qty-variant]').forEach((inp) => {
          inp.value = '0';
        });
        updatePurchaseTotal();
      }
    });

    root.querySelector('#add-purchase-product')?.addEventListener('click', () => {
      const newIdx = ++groupIndex;
      root.querySelector('#purchase-lines').insertAdjacentHTML('beforeend', groupMarkup(newIdx));
      renderGroup(root.querySelector(`[data-purchase-group="${newIdx}"]`));
      updatePurchaseTotal();
    });
  };
  document.querySelector('#new-purchase')?.addEventListener('click', () => purchase());
  document.querySelectorAll('.purchase-for-supplier').forEach((button) => button.addEventListener('click', (e) => {
    e.stopPropagation();
    purchase(button.dataset.supplier);
  }));
  document.querySelectorAll('.view-model-sizes-btn').forEach((button) => button.addEventListener('click', () => {
    const purchaseId = button.dataset.purchaseId;
    const modelKey = button.dataset.modelKey;
    const supplier = state.data.suppliers.find((s) => s.purchases.some((p) => p.id === purchaseId));
    const purchase = supplier?.purchases.find((p) => p.id === purchaseId);
    if (!purchase) return;
    const groups = groupPurchaseItemsByModel(purchase, state.data.products);
    const group = groups.find((g) => g.key === modelKey);
    if (group) showPurchaseModelVariantsModal(group, purchase, supplier);
  }));
  document.querySelectorAll('.print-purchase-labels').forEach((button) => button.addEventListener('click', () => {
    const purchaseRecord = state.data.suppliers.flatMap((supplier) => supplier.purchases).find((item) => item.id === button.dataset.purchaseId);
    if (purchaseRecord) showBarcodeLabelsModal({ purchase: purchaseRecord });
  }));
  document.querySelectorAll('.return-supplier-item').forEach((button) => button.addEventListener('click', () => {
    const purchase = state.data.suppliers.flatMap((supplier) => supplier.purchases).find((item) => item.id === button.dataset.purchase);
    const line = purchase?.items.find((item) => item.id === button.dataset.item);
    if (!line) return;
    supplierModal(`<p>${escapeHtml(line.productName)} \u00b7 \u0627\u0644\u0643\u0645\u064a\u0629 \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0644\u0644\u0625\u0631\u062c\u0627\u0639: <strong>${line.returnableQuantity}</strong>. \u064a\u064f\u062d\u0633\u0628 \u0631\u0635\u064a\u062f \u0627\u0644\u062a\u0627\u062c\u0631 \u0628\u0633\u0639\u0631 \u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629.</p><label>\u0627\u0644\u0643\u0645\u064a\u0629 \u0627\u0644\u0645\u0631\u0627\u062f \u0625\u0631\u062c\u0627\u0639\u0647\u0627<input name="quantity" type="number" min="1" max="${line.returnableQuantity}" step="1" value="1" required></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'supplier-return-form', `/api/purchases/${purchase.id}/returns`, (data) => ({ idempotencyKey: data.idempotencyKey, storeId: data.storeId, items: [{ purchaseItemId: line.id, quantity: data.quantity }] }), '\u062a\u0645 \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u0645\u0631\u062a\u062c\u0639 \u0648\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u0645\u062e\u0632\u0648\u0646 \u0648\u0631\u0635\u064a\u062f \u0627\u0644\u062a\u0627\u062c\u0631');
  }));
  document.querySelectorAll('.pay-purchase').forEach((button) => button.addEventListener('click', () => {
    const decimals = currencyDecimals(state.data.company.currency), digits = BigInt(button.dataset.remaining).toString().padStart(decimals + 1, '0');
    const maxAmount = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
    supplierModal(`<p>المتبقي: <strong>${money({ amount: button.dataset.remaining, currency: state.data.company.currency, decimals })}</strong></p><label>مبلغ السداد<input name="amount" inputmode="decimal" max="${maxAmount}" required></label><label>طريقة السداد<select name="paymentMethod"><option value="CASH">نقدي</option><option value="BANK_TRANSFER">تحويل بنكي</option><option value="CARD">بطاقة</option><option value="MOBILE">محفظة</option></select></label><label>رقم مرجعي<input name="referenceNumber" maxlength="80"></label><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'payment-form', `/api/purchases/${button.dataset.purchase}/payments`, (data) => ({ ...data, amount: toMinor(data.amount, currencyDecimals(state.data.company.currency)) }));
  }));

  document.querySelectorAll('[data-sup-preset]').forEach((btn) => btn.addEventListener('click', () => {
    const preset = btn.dataset.supPreset;
    state.supplierDatePreset = preset;
    const today = new Date().toISOString().slice(0, 10);
    if (preset === 'all') {
      state.supplierFrom = '';
      state.supplierTo = '';
    } else if (preset === 'today') {
      state.supplierFrom = today;
      state.supplierTo = today;
    } else if (preset === 'week') {
      const now = new Date();
      const firstDay = new Date(now.setDate(now.getDate() - now.getDay()));
      state.supplierFrom = firstDay.toISOString().slice(0, 10);
      state.supplierTo = today;
    } else if (preset === 'month') {
      state.supplierFrom = `${today.slice(0, 7)}-01`;
      state.supplierTo = today;
    }
    render();
  }));

  document.querySelector('#supplier-date-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    state.supplierDatePreset = 'custom';
    state.supplierFrom = String(fd.get('from') ?? '').trim();
    state.supplierTo = String(fd.get('to') ?? '').trim();
    render();
  });

  document.querySelector('.reset-sup-filter')?.addEventListener('click', () => {
    state.supplierDatePreset = 'all';
    state.supplierFrom = '';
    state.supplierTo = '';
    render();
  });
}

async function bindSalesHistory() {
  document.querySelectorAll('[data-sales-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = btn.dataset.salesPreset;
      state.salesPreset = preset;
      const today = new Date().toISOString().slice(0, 10);
      if (preset === 'today') {
        state.salesFrom = today;
        state.salesTo = today;
      } else if (preset === 'week') {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        state.salesFrom = d.toISOString().slice(0, 10);
        state.salesTo = today;
      } else if (preset === 'month') {
        const d = new Date();
        d.setDate(1);
        state.salesFrom = d.toISOString().slice(0, 10);
        state.salesTo = today;
      } else {
        state.salesFrom = '';
        state.salesTo = '';
      }
      state.salesHistory = [];
      state.salesHistoryTotal = 0;
      await fetchSalesHistory(0, false);
    });
  });

  const searchForm = document.querySelector('#sales-history-search');
  searchForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const filters = new FormData(searchForm);
    const search = String(filters.get('search') ?? '').trim();
    const from = String(filters.get('from') ?? '').trim();
    const to = String(filters.get('to') ?? '').trim();
    if ((from && !to) || (!from && to)) {
      toast('يجب تحديد تاريخي البداية والنهاية معاً أو تركهما فارغين', 'error');
      return;
    }
    if (from && to && from > to) {
      toast('تاريخ البداية لازم يكون قبل تاريخ النهاية', 'error');
      return;
    }
    state.salesPreset = 'custom';
    state.salesHistorySearch = search;
    state.salesFrom = from;
    state.salesTo = to;
    state.salesHistory = [];
    state.salesHistoryTotal = 0;
    await fetchSalesHistory(0, false);
  });

  document.querySelector('#reset-sales-filter')?.addEventListener('click', async () => {
    state.salesPreset = 'all';
    state.salesHistorySearch = '';
    state.salesFrom = '';
    state.salesTo = '';
    state.salesHistory = [];
    state.salesHistoryTotal = 0;
    await fetchSalesHistory(0, false);
  });

  document.querySelector('#sales-history-more')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const currentLength = (state.salesHistory ?? state.data.sales ?? []).length;
    await fetchSalesHistory(currentLength, true, button);
  });
}

async function fetchSalesHistory(offset, append, button = null) {
  try {
    const searchVal = (state.salesHistorySearch ?? '').trim();
    const queryObj = {
      storeId: state.data.selectedStoreId,
      offset: String(offset),
      limit: '100',
    };
    if (searchVal) queryObj.search = searchVal;
    if (state.salesFrom && state.salesTo) {
      queryObj.from = state.salesFrom;
      queryObj.to = state.salesTo;
    }
    const params = new URLSearchParams(queryObj);
    const result = await api(`/api/sales?${params.toString()}`);
    state.salesHistory = append ? [...(state.salesHistory ?? []), ...result.payload.sales] : result.payload.sales;
    state.salesHistoryTotal = result.payload.total;
    render();
  } catch (error) {
    toast(error.message, 'error');
    if (button) button.disabled = false;
  }
}

function bindSaleInvoiceButtons() {
  document.querySelectorAll('[data-sale-open]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/sales/${encodeURIComponent(button.dataset.saleOpen)}`);
      showSaleDetails(result.payload);
    } catch (error) { toast(error.message, 'error'); }
  }));
}

function showSaleDetails(sale) {
  const root = getModalRoot();
  const totalReturned = (sale.returns ?? []).reduce((sum, item) => sum + BigInt(typeof item.refundAmount === 'object' ? item.refundAmount.amount : item.refundAmount || '0'), 0n).toString();
  const hasDiscount = sale.discountTotal && BigInt(sale.discountTotal.amount) > 0n;
  const hasChange = sale.changeGiven && BigInt(sale.changeGiven.amount) > 0n;
  const canReturn = (state.data.capabilities.canRefund || state.data.capabilities.canReturnSale || state.data.capabilities.cashierMode) && (sale.items ?? []).some((item) => BigInt(item.returnableQuantity ?? item.quantity ?? '0') > 0n);

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card invoice-detail-card" role="dialog" aria-modal="true" aria-labelledby="sale-details-title">
        <div class="modal-heading">
          <div style="display:flex;align-items:center;gap:12px;">
            <div>
              <span class="eyebrow eyebrow-dark">فاتورة مبيعات المتجر</span>
              <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
                <h2 id="sale-details-title" style="margin:0;font-size:18px;font-weight:800;">فاتورة مبيعات</h2>
                <span class="invoice-number-chip">#${escapeHtml(sale.saleNumber)}</span>
              </div>
            </div>
          </div>
          <button class="modal-close" data-close-modal aria-label="إغلاق">×</button>
        </div>

        <div class="modal-body invoice-modal-body">
          <div class="invoice-meta-badges">
            <div class="invoice-meta-badge">
              <small>تاريخ وتوقيت الفاتورة</small>
              <strong>${new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sale.createdAt))}</strong>
            </div>
            <div class="invoice-meta-badge">
              <small>الكاشير المسؤول</small>
              <strong>${escapeHtml(sale.cashierName)}</strong>
            </div>
            <div class="invoice-meta-badge">
              <small>العميل</small>
              <strong>${escapeHtml(sale.customerName || 'عميل نقدي')}</strong>
            </div>
          </div>

          <div class="invoice-table-container">
            <div class="table-scroll" style="margin:0;">
              <table class="invoice-table zebra-table">
                <thead>
                  <tr>
                    <th>الصنف / الموديل</th>
                    <th>كود القطعة</th>
                    <th style="text-align:center;">الكمية</th>
                    <th>سعر الوحدة</th>
                    ${hasDiscount ? '<th>الخصم</th>' : ''}
                    <th>الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  ${sale.items.map((item) => `
                    <tr>
                      <td><strong>${escapeHtml(item.name)}</strong></td>
                      <td><span class="sku-code">${escapeHtml(item.sku)}</span></td>
                      <td style="text-align:center;"><strong>${item.quantity}</strong></td>
                      <td>${money(item.unitPrice)}</td>
                      ${hasDiscount ? `<td>${money({ ...item.netRevenue, amount: (BigInt(item.lineDiscount?.amount ?? '0') + BigInt(item.cartDiscountShare?.amount ?? '0')).toString() })}</td>` : ''}
                      <td class="table-total">${money(item.netRevenue)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <div class="invoice-clean-summary">
            ${hasDiscount ? `
              <div class="summary-line">
                <span>الإجمالي قبل الخصم:</span>
                <span>${money(sale.subtotal)}</span>
              </div>
              <div class="summary-line" style="color:var(--rose,var(--rose, #be123c));">
                <span>قيمة الخصم:</span>
                <strong>- ${money(sale.discountTotal)}</strong>
              </div>
            ` : ''}
            <div class="summary-line main-total">
              <span>إجمالي الفاتورة المطلوب:</span>
              <strong class="grand-amount">${money(sale.total)}</strong>
            </div>
            <div class="summary-line payment-line">
              <span>طريقة السداد:</span>
              <span class="payment-badge">${sale.payments.map((p) => `${methodLabel(p.method)}: ${money(p.amount)}`).join(' · ')}</span>
            </div>
            ${hasChange ? `
              <div class="summary-line change-line">
                <span>المتبقي للعميل (الباقي):</span>
                <strong>${money(sale.changeGiven)}</strong>
              </div>
            ` : ''}
          </div>

          ${sale.returns.length ? `
            <div class="invoice-returns-box" style="padding:14px 18px;background:rgba(190, 18, 60, 0.05);border:1px solid rgba(190, 18, 60, 0.22);border-radius:12px;">
              <strong style="color:var(--rose,var(--rose, #be123c));font-size:13.5px;display:block;margin-bottom:8px;">المرتجعات المسجلة:</strong>
              <div style="display:flex;flex-direction:column;gap:6px;">
                ${sale.returns.map((item) => `
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;padding:4px 0;">
                    <span>${escapeHtml(item.returnNumber)} · ${methodLabel(item.paymentMethod)}</span>
                    <strong>${money(item.refundAmount)}</strong>
                  </div>
                `).join('')}
              </div>
              <div style="border-top:1px dashed rgba(190, 18, 60, 0.25);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;font-weight:700;font-size:13px;">
                <span>إجمالي المرتجع:</span>
                <strong style="color:var(--rose,var(--rose, #be123c));">${money({ ...sale.total, amount: totalReturned })}</strong>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="modal-actions" style="display:flex;justify-content:space-between;align-items:center;">
          <button class="button button-secondary" data-close-modal>إغلاق</button>
          <div style="display:flex;align-items:center;gap:10px;">
            ${canReturn ? '<button class="button button-secondary" type="button" id="invoice-start-return-btn" style="color:var(--rose,var(--rose, #be123c));border-color:var(--rose,var(--rose, #be123c));font-weight:700;">عمل مرتجع من هذه الفاتورة</button>' : ''}
            <button class="button button-primary" type="button" data-print-invoice>طباعة الفاتورة</button>
          </div>
        </div>
      </section>
    </div>
  `;
  root.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  root.querySelector('[data-print-invoice]')?.addEventListener('click', () => void showThermalReceiptModal(sale.id));
  root.querySelector('#invoice-start-return-btn')?.addEventListener('click', () => {
    openSaleReturnModal(sale);
  });
}

async function openSaleReturnModal(saleOrId) {
  let sale = typeof saleOrId === 'object' && saleOrId ? saleOrId : null;
  const saleId = typeof saleOrId === 'string' ? saleOrId : sale?.id;
  if (!sale || !sale.items || !sale.items[0] || sale.items[0].returnableQuantity === undefined) {
    try {
      const res = await api(`/api/sales/${encodeURIComponent(saleId)}`);
      sale = res.payload;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }

  const returnableItems = (sale.items ?? []).filter((item) => BigInt(item.returnableQuantity ?? '0') > 0n);
  if (!returnableItems.length) {
    toast('جميع أصناف هذه الفاتورة تم إرجاعها بالفعل', 'error');
    return;
  }

  const root = getModalRoot();
  const currency = sale.total?.currency || state.data.company.currency;
  const decimals = sale.total?.decimals ?? currencyDecimals(currency);

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card invoice-detail-card" role="dialog" aria-modal="true" aria-labelledby="return-modal-title">
        <div class="modal-heading" style="padding:18px 26px; border-bottom:1px solid var(--line);">
          <div>
            <span class="eyebrow eyebrow-dark">إرجاع مبيعات · إرجاع قطعة معينة أو الفاتورة</span>
            <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
              <h2 id="return-modal-title" style="margin:0;font-size:18px;font-weight:800;">تسجيل مرتجع من فاتورة</h2>
              <span class="invoice-number-chip">#${escapeHtml(sale.saleNumber)}</span>
            </div>
            <p style="margin-top:4px;">حدد عدد القطع المراد إرجاعها لكل صنف (يمكن إرجاع قطعة واحدة فقط) مع طريقة رد المبلغ.</p>
          </div>
          <button type="button" class="modal-close" data-close-return aria-label="إغلاق">×</button>
        </div>

        <form id="sale-return-form" class="modal-form" style="padding:22px 26px; display:flex; flex-direction:column; gap:16px;">
          <div class="invoice-table-container">
            <div class="table-scroll" style="margin:0;">
              <table class="invoice-table zebra-table return-items-table" style="margin:0; width:100%;">
                <thead>
                  <tr>
                    <th>الصنف / الموديل</th>
                    <th>الكمية المشتراة</th>
                    <th>المتاح للإرجاع</th>
                    <th>سعر القطعة</th>
                    <th style="min-width:140px;text-align:center;">الكمية المراد إرجاعها</th>
                    <th>المبلغ المسترد</th>
                  </tr>
                </thead>
                <tbody>
                  ${returnableItems.map((item) => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(item.name)}</strong>
                        <div style="font-size:10.5px;color:var(--muted);">${escapeHtml(item.sku)}</div>
                      </td>
                      <td>${item.quantity} قطعة</td>
                      <td><strong style="color:var(--brand);">${item.returnableQuantity} قطعة</strong></td>
                      <td>${money(item.unitPrice)}</td>
                      <td style="text-align:center;">
                        <div class="quantity-control" style="display:inline-flex;margin:auto;">
                          <button type="button" data-return-step="-1" data-item-id="${item.id}">−</button>
                          <input type="number" name="qty:${item.id}" data-item-id="${item.id}" min="0" max="${item.returnableQuantity}" step="1" value="0" style="width:50px;height:26px;text-align:center;font-weight:800;border:0;background:transparent;">
                          <button type="button" data-return-step="1" data-item-id="${item.id}">+</button>
                        </div>
                      </td>
                      <td class="table-total" data-item-refund="${item.id}">0 ${currency}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <div class="invoice-clean-summary" style="margin:0; padding:18px 22px; border-radius:12px;">
            <div class="summary-line">
              <span>إجمالي القطع المحددة للإرجاع:</span>
              <strong id="return-total-pieces" style="font-size:15px;color:var(--rose,var(--rose, #be123c));">0 قطعة</strong>
            </div>
            <div class="summary-line main-total">
              <span>إجمالي المبلغ المسترد للعميل:</span>
              <strong class="grand-amount" id="return-total-amount" style="color:var(--rose,var(--rose, #be123c));">0 ${currency}</strong>
            </div>
            <div class="form-grid" style="margin-top:12px;">
              <label>
                <span>طريقة رد المبلغ للعميل</span>
                <select name="paymentMethod" required style="height:40px;">
                  <option value="CASH">نقدي (من درج النقدية)</option>
                  <option value="CARD">بطاقة</option>
                  <option value="MOBILE">محفظة إلكترونية</option>
                  <option value="OTHER">أخرى</option>
                </select>
              </label>
              <label>
                <span>سبب الإرجاع / ملاحظات (اختياري)</span>
                <input name="notes" placeholder="مقاس غير مناسب، استبدال، إلخ" style="height:40px;">
              </label>
            </div>
          </div>

          <div class="modal-actions" style="margin:0; padding:16px 26px; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center;">
            <button type="button" class="button button-secondary" data-close-return>إلغاء</button>
            <button type="submit" class="button button-primary" id="confirm-sale-return-btn" disabled style="background:var(--rose,var(--rose, #be123c));border-color:var(--rose,var(--rose, #be123c));">
              تأكيد إرجاع القطع ورد المبلغ
            </button>
          </div>
        </form>
      </section>
    </div>
  `;

  const close = () => { root.innerHTML = ''; };
  root.querySelectorAll('[data-close-return]').forEach((b) => b.addEventListener('click', close));

  const form = root.querySelector('#sale-return-form');
  const confirmBtn = root.querySelector('#confirm-sale-return-btn');
  const totalPiecesEl = root.querySelector('#return-total-pieces');
  const totalAmountEl = root.querySelector('#return-total-amount');

  const updateCalculations = () => {
    let totalPieces = 0n;
    let totalMinor = 0n;
    returnableItems.forEach((item) => {
      const input = form.querySelector(`input[name="qty:${item.id}"]`);
      const val = Math.max(0, Math.min(Number(item.returnableQuantity), Math.floor(Number(input.value) || 0)));
      input.value = val;
      const qty = BigInt(val);
      const price = BigInt(item.unitPrice.amount);
      const lineMinor = qty * price;
      totalPieces += qty;
      totalMinor += lineMinor;
      const lineRefundEl = root.querySelector(`[data-item-refund="${item.id}"]`);
      if (lineRefundEl) lineRefundEl.textContent = money({ amount: lineMinor.toString(), currency, decimals });
    });

    totalPiecesEl.textContent = `${totalPieces} قطعة`;
    totalAmountEl.textContent = money({ amount: totalMinor.toString(), currency, decimals });
    confirmBtn.disabled = totalPieces <= 0n;
    confirmBtn.textContent = totalPieces > 0n
      ? `↩️ تأكيد إرجاع (${totalPieces} قطعة) بمبلغ ${money({ amount: totalMinor.toString(), currency, decimals })}`
      : 'حدد قطعة واحدة على الأقل للإرجاع';
  };

  root.querySelectorAll('[data-return-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = form.querySelector(`input[name="qty:${btn.dataset.itemId}"]`);
      const step = Number(btn.dataset.returnStep);
      input.value = Math.max(0, Math.min(Number(input.max), (Number(input.value) || 0) + step));
      updateCalculations();
    });
  });

  form.querySelectorAll('input[type="number"]').forEach((input) => {
    input.addEventListener('input', updateCalculations);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    confirmBtn.disabled = true;
    try {
      const items = returnableItems
        .map((item) => ({
          originalSaleItemId: item.id,
          quantity: form.querySelector(`input[name="qty:${item.id}"]`).value,
        }))
        .filter((item) => BigInt(item.quantity) > 0n);

      if (!items.length) throw new Error('حدد صنفًا واحدًا على الأقل للمرتجع');

      const body = {
        idempotencyKey: crypto.randomUUID(),
        storeId: state.data.selectedStoreId,
        paymentMethod: form.elements.namedItem('paymentMethod').value,
        items,
      };

      await api(`/api/sales/${encodeURIComponent(sale.id)}/returns`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      close();
      render();
      toast('تم تسجيل المرتجع بنجاح وتحديث أرصدة المخزون والمبلغ');
    } catch (err) {
      toast(err.message, 'error');
      confirmBtn.disabled = false;
    }
  });
}

function bindReturns() {
  document.querySelectorAll('.start-return').forEach((button) => button.addEventListener('click', () => {
    openSaleReturnModal(button.dataset.sale);
  }));
}

function bindMonthlyExpenses() {
  // Month archive navigation
  document.querySelector('#btn-prev-month')?.addEventListener('click', async (e) => {
    const y = Number(e.currentTarget.dataset.year);
    const m = Number(e.currentTarget.dataset.month);
    state.selectedExpenseYear = y;
    state.selectedExpenseMonth = m;
    await loadData(state.data.selectedStoreId, y, m);
    render();
  });

  document.querySelector('#btn-next-month')?.addEventListener('click', async (e) => {
    const y = Number(e.currentTarget.dataset.year);
    const m = Number(e.currentTarget.dataset.month);
    state.selectedExpenseYear = y;
    state.selectedExpenseMonth = m;
    await loadData(state.data.selectedStoreId, y, m);
    render();
  });

  document.querySelector('#btn-current-month')?.addEventListener('click', async (e) => {
    const y = Number(e.currentTarget.dataset.year);
    const m = Number(e.currentTarget.dataset.month);
    state.selectedExpenseYear = y;
    state.selectedExpenseMonth = m;
    await loadData(state.data.selectedStoreId, y, m);
    render();
  });

  document.querySelector('#expense-month-picker')?.addEventListener('change', async (e) => {
    const [y, m] = e.currentTarget.value.split('-').map(Number);
    state.selectedExpenseYear = y;
    state.selectedExpenseMonth = m;
    await loadData(state.data.selectedStoreId, y, m);
    render();
  });

  // Add obligation (supports setting initialAmount for current month in 1 step)
  document.querySelector('#new-monthly-obligation, #empty-new-monthly-obligation')?.addEventListener('click', () => {
    const decimals = currencyDecimals(state.data.company.currency);
    supplierModal(`
      <label style="font-weight:700;">اسم الالتزام
        <input name="name" required minlength="2" maxlength="120" placeholder="مثال: إيجار المحل" autofocus>
      </label>
      <label style="font-weight:700;margin-top:10px;">التصنيف
        <select name="categoryCode">
          <option value="RENT">إيجار</option>
          <option value="UTILITIES">مرافق وفواتير</option>
          <option value="TRANSPORT">نقل ومواصلات</option>
          <option value="MAINTENANCE">صيانة</option>
          <option value="SUPPLIES">مستلزمات تشغيل</option>
          <option value="OTHER">أخرى</option>
        </select>
      </label>
      <div class="form-grid" style="margin-top:10px;">
        <label style="font-weight:700;">مبلغ الشهر (${state.data.company.currency})
          <input name="initialAmount" inputmode="decimal" placeholder="مثال: 4000">
        </label>
        <label style="font-weight:700;">يوم الاستحقاق في الشهر
          <input name="dueDay" type="number" min="1" max="31" value="1" required>
        </label>
      </div>
      <input type="hidden" name="storeId" value="${state.data.selectedStoreId}">
      <input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">
    `,
    'monthly-obligation-form',
    '/api/recurring-expenses',
    (data) => ({
      storeId: data.storeId,
      categoryCode: data.categoryCode,
      name: data.name,
      dueDay: Number(data.dueDay),
      initialAmount: data.initialAmount ? toMinor(data.initialAmount, decimals) : undefined,
      idempotencyKey: data.idempotencyKey
    }),
    'تم إضافة الالتزام وتثبيت مبلغه بنجاح');
  });

  // Confirm monthly amount
  document.querySelectorAll('.confirm-monthly').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const period = state.data.monthlyPeriod;
    const decimals = currencyDecimals(state.data.company.currency);
    const name = button.dataset.name || 'الالتزام';
    const suggested = button.dataset.suggested || '';

    supplierModal(`
      <div style="font-size:15px;font-weight:800;color:var(--ink);margin-bottom:12px;">تحديد قيمة ${escapeHtml(name)} لشهر <strong>${period.month} / ${period.year}</strong></div>
      <label style="font-weight:700;font-size:13.5px;color:var(--ink);">إجمالي المبلغ للشهر (${state.data.company.currency}):
        <input name="amount" inputmode="decimal" value="${suggested}" placeholder="مثال: 4000" required autofocus style="font-weight:800;font-size:18px;height:44px;color:var(--purple);padding:0 12px;margin-top:6px;">
      </label>
      <input type="hidden" name="year" value="${period.year}">
      <input type="hidden" name="month" value="${period.month}">
    `,
    'monthly-actual-form',
    `/api/recurring-expenses/${button.dataset.obligation}/actual`,
    (data) => ({ year: Number(data.year), month: Number(data.month), amount: toMinor(data.amount, decimals) }),
    'تم تحديد وتأكيد قيمة الشهر بنجاح');
  }));

  // Pay monthly (clean, minimal modal with daily share pre-filled)
  document.querySelectorAll('.pay-monthly').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const decimals = currencyDecimals(state.data.company.currency);
    const digits = BigInt(button.dataset.remaining).toString().padStart(decimals + 1, '0');
    const maxAmount = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
    const dailySuggested = button.dataset.daily || '';
    const name = button.dataset.name || 'الإيجار';

    supplierModal(`
      <div style="background:var(--surface-soft);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-size:12px;color:var(--muted);font-weight:700;">سداد التزام شهري:</span>
          <h3 style="margin:2px 0 0;font-size:16px;font-weight:800;color:var(--ink);">${escapeHtml(name)}</h3>
        </div>
        <div style="text-align:left;">
          <span style="font-size:11px;color:var(--muted);font-weight:700;">المتبقي غير المسدد</span>
          <div style="font-size:14px;font-weight:800;color:var(--rose, #be123c);">${maxAmount} ${state.data.company.currency}</div>
        </div>
      </div>

      <label style="font-weight:700;font-size:13.5px;color:var(--ink);">المبلغ المراد سداده الآن (${state.data.company.currency}):
        <input name="amount" inputmode="decimal" value="${dailySuggested}" max="${maxAmount}" required autofocus style="font-weight:800;font-size:19px;height:46px;color:var(--purple);padding:0 12px;margin-top:6px;border-radius:8px;">
        <small style="display:block;margin-top:4px;font-size:11.5px;color:var(--muted);">المقسومة اليومية المقترحة لهذا الشهر: <strong>${dailySuggested} ${state.data.company.currency}</strong> (يمكنك تعديل المبلغ لما يناسبك).</small>
      </label>

      <div class="form-grid" style="margin-top:12px;">
        <label style="font-weight:700;font-size:13px;color:var(--ink);">طريقة الدفع (الخصم من):
          <select name="paymentMethod" style="height:42px;border-radius:8px;">
            <option value="CASH_DRAWER">درج النقدية</option>
            <option value="CASH_SAFE">الخزينة</option>
            <option value="BANK_TRANSFER">تحويل بنكي</option>
          </select>
        </label>
        <label style="font-weight:700;font-size:13px;color:var(--ink);">بيان وملاحظات:
          <input name="referenceNumber" maxlength="80" value="سداد دفعة" style="height:42px;border-radius:8px;">
        </label>
      </div>

      <div style="margin-top:12px;padding:10px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:var(--green, #15803d);display:flex;align-items:center;gap:8px;">
        
        <span>المبلغ الذي تدفعه وتؤكده هنا فقط هو ما سيتم خصمه فورياً من أرباح المتجر وخزينة النقدية.</span>
      </div>

      <input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">
    `,
    'monthly-payment-form',
    `/api/monthly-expenses/${button.dataset.actual}/payments`,
    (data) => ({ ...data, amount: toMinor(data.amount, decimals) }),
    'تم تسجيل السداد بنجاح وخصمه من أرباح المتجر');
  }));
}

function showNotificationsModal() {
  const root = getModalRoot();
  const lowStock = state.data.lowStock ?? [];
  const suppliersDue = (state.data.suppliers ?? []).filter((s) => {
    const due = s.purchases.reduce((sum, p) => sum + BigInt(p.remainingAmount.amount), 0n);
    return due > 0n;
  });
  const monthlyDue = (state.data.monthlyExpenses ?? []).filter((m) => m.actual && BigInt(m.actual.remainingAmount.amount) > 0n);
  const totalAlerts = lowStock.length + suppliersDue.length + monthlyDue.length;
  const currency = state.data.company.currency;
  const decimals = currencyDecimals(currency);

  root.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card" style="width:min(620px, 94vw);max-height:85vh;overflow:auto;" role="dialog" aria-modal="true" aria-labelledby="notifications-modal-title">
        <div class="modal-heading">
          <div style="display:flex;align-items:center;gap:12px;">
            <span class="status-pill status-complete" style="font-weight:800;font-size:12px;padding:6px 12px;border-radius:8px;">إشعارات</span>
            <div>
              <h2 id="notifications-modal-title" style="margin:0;font-size:17px;font-weight:800;color:var(--ink);">مركز الإشعارات والتنبيهات</h2>
              <p style="margin:2px 0 0;font-size:12px;color:var(--muted);">${totalAlerts > 0 ? `لديك ${totalAlerts} تنبيه يتطلب المتابعة` : 'جميع الحسابات والمخزون في حالة ممتازة'}</p>
            </div>
          </div>
          <button type="button" class="modal-close" data-close-notifications>×</button>
        </div>

        <div style="display:grid;gap:14px;padding:8px 0 16px;">
          ${lowStock.length ? `
            <div class="notif-alert-box notif-alert-amber">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <strong class="notif-title" style="font-size:13.5px;display:inline-flex;align-items:center;gap:6px;">نواقص المخزون (${lowStock.length} موديل وصل لحد الطلب)</strong>
                <button type="button" class="button button-sm button-secondary" data-nav-to="inventory" style="font-size:11.5px;padding:3px 10px;height:28px;">فتح المخزون</button>
              </div>
              <div style="display:grid;gap:6px;max-height:160px;overflow-y:auto;font-size:12px;">
                ${lowStock.slice(0, 10).map((p) => {
                  const qty = p.variants.reduce((sum, v) => sum + BigInt(v.quantity), 0n);
                  return `<div class="notif-divider" style="display:flex;justify-content:space-between;padding:4px 0;"><span>• <strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.sku)})</span><span style="font-weight:700;">المتبقي: ${qty} قطعة</span></div>`;
                }).join('')}
              </div>
            </div>
          ` : ''}

          ${suppliersDue.length ? `
            <div class="notif-alert-box notif-alert-rose">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <strong class="notif-title" style="font-size:13.5px;display:inline-flex;align-items:center;gap:6px;">مستحقات للتجار غير مسددة (${suppliersDue.length} تاجر)</strong>
                <button type="button" class="button button-sm button-secondary" data-nav-to="suppliers" style="font-size:11.5px;padding:3px 10px;height:28px;">فتح التجار</button>
              </div>
              <div style="display:grid;gap:6px;max-height:160px;overflow-y:auto;font-size:12px;">
                ${suppliersDue.map((s) => {
                  const due = s.purchases.reduce((sum, p) => sum + BigInt(p.remainingAmount.amount), 0n);
                  return `<div class="notif-divider" style="display:flex;justify-content:space-between;padding:4px 0;"><span>• <strong>${escapeHtml(s.name)}</strong></span><span class="notif-amount" style="font-weight:800;">متبقي: ${money({ amount: due.toString(), currency, decimals })}</span></div>`;
                }).join('')}
              </div>
            </div>
          ` : ''}

          ${monthlyDue.length ? `
            <div class="notif-alert-box notif-alert-purple">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <strong class="notif-title" style="font-size:13.5px;display:inline-flex;align-items:center;gap:6px;">التزامات شهرية مستحقة السداد (${monthlyDue.length} بند)</strong>
                <button type="button" class="button button-sm button-secondary" data-nav-to="monthly-expenses" style="font-size:11.5px;padding:3px 10px;height:28px;">فتح المصروفات</button>
              </div>
              <div style="display:grid;gap:6px;max-height:160px;overflow-y:auto;font-size:12px;">
                ${monthlyDue.map((m) => `
                  <div class="notif-divider" style="display:flex;justify-content:space-between;padding:4px 0;">
                    <span>• <strong>${escapeHtml(m.name)}</strong> (${escapeHtml(m.category)})</span>
                    <span class="notif-amount" style="font-weight:800;">متبقي: ${money(m.actual.remainingAmount)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${!totalAlerts ? `
            <div style="text-align:center;padding:34px 16px;">
              
              <strong style="font-size:16px;color:var(--ink);display:block;">كل الأمور ممتازة وتحت السيطرة!</strong>
              <p style="font-size:12.5px;color:var(--muted);margin:6px 0 0;">لا توجد نواقص في المخزون أو فواتير تجار متأخرة أو التزامات شهرية معلقة حالياً.</p>
            </div>
          ` : ''}
        </div>

        <div class="modal-actions">
          <button type="button" class="button button-secondary" data-close-notifications>إغلاق</button>
        </div>
      </section>
    </div>
  `;

  root.querySelectorAll('[data-close-notifications]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; }));
  // Backdrop click dismissal disabled
  root.querySelectorAll('[data-nav-to]').forEach((b) => b.addEventListener('click', () => {
    state.page = b.dataset.navTo;
    root.innerHTML = '';
    render();
  }));
}

function currencyDecimals(currency) {
  return ['JPY', 'KRW'].includes(currency) ? 0 : ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency) ? 3 : 2;
}

function bindShell() {
  document.querySelector('#global-notifications-btn, .notification-button')?.addEventListener('click', () => {
    showNotificationsModal();
  });
  document.querySelector('#header-attendance-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/attendance/check-in', { method: 'POST' });
      toast('تم تسجيل حضورك اليوم بنجاح');
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
    } catch (error) {
      toast(error.message, 'error');
      btn.disabled = false;
    }
  });
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => {
    closeAccountMenu();
    state.page = button.dataset.page;
    state.query = '';
    render();
  }));
  document.querySelector('#store-select')?.addEventListener('change', async (event) => {
    try {
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      state.salesHistoryTotal = 0;
      await loadData(event.target.value);
      render();
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('#change-password')?.addEventListener('click', () => { closeAccountMenu(); showChangePasswordModal(); });
  const accountMenu = document.querySelector('#account-menu');
  const accountToggle = document.querySelector('#account-menu-toggle');
  accountToggle?.addEventListener('click', () => {
    if (!accountMenu.hidden) { closeAccountMenu(); return; }
    accountMenu.hidden = false;
    accountToggle.setAttribute('aria-expanded', 'true');
    document.querySelector('.sidebar')?.classList.add('account-menu-open');
  });
  document.querySelector('#theme-toggle')?.addEventListener('click', (event) => {
    const theme = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(theme);
    event.currentTarget.innerHTML = `${icon(theme === 'dark' ? 'sun' : 'moon', 17)}<span>${theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن'}</span>`;
  });
  document.querySelector('#logout-button')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    state.data = null;
    state.cart = [];
    render();
  });
  const search = document.querySelector('#global-search');
  search?.addEventListener('input', (event) => { state.query = event.target.value; const cursor = event.target.selectionStart; render(); const next = document.querySelector('#global-search'); next?.focus(); next?.setSelectionRange(cursor, cursor); });
  search?.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const term = state.query.trim();
    if (!term) { state.page = state.data.capabilities.cashierMode ? 'inventory' : 'products'; render(); return; }
    try {
      const params = new URLSearchParams({ storeId: state.data.selectedStoreId, offset: '0', limit: '100', search: term });
      const result = await api(`/api/sales?${params.toString()}`);
      if (result.payload.total > 0) {
        state.salesHistorySearch = term;
        state.salesHistory = result.payload.sales;
        state.salesHistoryTotal = result.payload.total;
        state.salesFrom = '1970-01-01';
        state.salesTo = new Date().toISOString().slice(0, 10);
        state.page = 'sales';
      } else {
        state.page = state.data.capabilities.cashierMode ? 'inventory' : 'products';
      }
      render();
    } catch (error) { toast(error.message, 'error'); }
  });
  if (state.page === 'products') bindProducts();
  if (state.page === 'inventory') bindInventory();
  if (state.page === 'pos') bindPos();
  if (state.page === 'suppliers') bindSuppliers();
  if (state.page === 'sales') { bindReturns(); bindSalesHistory(); }
  bindSaleInvoiceButtons();
  if (state.page === 'monthly-expenses' || state.page === 'expenses') bindExpenses();
  if (state.page === 'financial-map') bindFinancialMap();
  if (state.page === 'reports') bindProfitLoss();
  if (state.page === 'top-products') bindTopProducts();
  if (state.page === 'backups') bindBackups();
  if (state.page === 'shifts') bindShifts(); if (state.page === 'users') bindUsers(); if (state.page === 'audit-logs') bindAuditLogs(); if (state.page === 'accounting') bindAccounting();
  document.querySelector('#header-start-shift-btn')?.addEventListener('click', () => {
    showStartShiftModal();
  });
  document.querySelector('#header-end-shift-btn')?.addEventListener('click', () => {
    showEndShiftModal();
  });
  document.addEventListener('keydown', handleShortcuts, { once: true });
}

function bindAuditLogs() { const key = `${state.data.selectedStoreId}:audit`; if (state.auditLogsKey === key && state.auditLogs) return; state.auditLogsKey = key; void api(`/api/audit-logs?storeId=${encodeURIComponent(state.data.selectedStoreId)}&limit=100`).then((result) => { state.auditLogs = result.entries; state.auditChainVerification = result.chainVerification; render(); }).catch((error) => { state.auditLogsKey = null; toast(error.message, 'error'); }); }
async function showThermalReceiptModal(saleId) {
  try {
    const { receipt } = await api(`/api/sales/${encodeURIComponent(saleId)}/receipt?width=80mm`);
    const root = getModalRoot();
    const formattedDate = new Date(receipt.createdAt).toLocaleString('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    root.innerHTML = `
      <div class="modal-backdrop">
        <section class="modal-card thermal-receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="thermal-preview-title">
          <div class="modal-heading">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="thermal-receipt-chip">إيصال حراري ${escapeHtml(receipt.width || '80mm')}</span>
              <h2 id="thermal-preview-title" style="margin:0;font-size:16px;font-weight:800;">معاينة الإيصال قبل الطباعة</h2>
            </div>
            <button class="modal-close" data-close-modal aria-label="إغلاق">×</button>
          </div>

          <div class="modal-body thermal-receipt-body">
            <div class="thermal-receipt-paper" id="printable-thermal-receipt">
              <div class="thermal-header">
                <div class="thermal-store-name">${escapeHtml(receipt.companyName)}</div>
                ${receipt.storeName ? `<div class="thermal-branch-name">${escapeHtml(receipt.storeName)}</div>` : ''}
                <div class="thermal-receipt-num">إيصال رقم: #${escapeHtml(receipt.saleNumber)}</div>
              </div>

              <div class="thermal-divider-dashed"></div>

              <div class="thermal-meta-list">
                <div class="thermal-meta-row">
                  <span>التاريخ والوقت:</span>
                  <strong>${formattedDate}</strong>
                </div>
                <div class="thermal-meta-row">
                  <span>الكاشير المسؤول:</span>
                  <strong>${escapeHtml(receipt.cashierName)}</strong>
                </div>
                ${receipt.customerName ? `
                  <div class="thermal-meta-row">
                    <span>العميل:</span>
                    <strong>${escapeHtml(receipt.customerName)}</strong>
                  </div>
                ` : ''}
              </div>

              <div class="thermal-divider-dashed"></div>

              <table class="thermal-items-table">
                <thead>
                  <tr>
                    <th style="text-align:right;">الصنف</th>
                    <th style="text-align:center;">الكمية</th>
                    <th style="text-align:center;">السعر</th>
                    <th style="text-align:left;">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  ${receipt.items.map((item) => `
                    <tr>
                      <td class="thermal-item-desc">
                        <strong>${escapeHtml(item.productName)}</strong>
                        ${item.sku ? `<small class="thermal-sku">${escapeHtml(item.sku)}</small>` : ''}
                      </td>
                      <td style="text-align:center;font-weight:700;">${escapeHtml(item.quantity)}</td>
                      <td style="text-align:center;">${money(item.unitPrice)}</td>
                      <td style="text-align:left;font-weight:800;">${money(item.lineTotal)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>

              <div class="thermal-divider-dashed"></div>

              <div class="thermal-totals">
                <div class="thermal-total-row main">
                  <span>الإجمالي المطلوب:</span>
                  <strong class="thermal-grand-total">${money(receipt.total)}</strong>
                </div>
                <div class="thermal-total-row">
                  <span>المدفوع:</span>
                  <span>${money(receipt.paidTotal)}</span>
                </div>
                <div class="thermal-total-row">
                  <span>المتبقي (الباقي):</span>
                  <span>${money(receipt.changeGiven)}</span>
                </div>
              </div>

              <div class="thermal-divider-dashed"></div>

              <div class="thermal-footer">
                <p>شكرًا لزيارتكم! نتشرف بخدمتكم دائمًا.</p>
                <small>نسخة إلكترونية مطابقة لطابعة الكاشير</small>
              </div>
            </div>
          </div>

          <div class="modal-actions" style="margin:0; padding:16px 24px; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center;">
            <button type="button" class="button button-secondary" data-close-modal>إغلاق</button>
            <button type="button" class="button button-primary" id="confirm-thermal-print" style="font-weight:800;">
              طباعة الإيصال الآن
            </button>
          </div>
        </section>
      </div>`;
    root.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; }));
    root.querySelector('#confirm-thermal-print')?.addEventListener('click', () => window.print());
  } catch (error) {
    toast(error.message, 'error');
  }
}
function bindAccounting() { const decimals = currencyDecimals(state.data.company.currency); document.querySelectorAll('#treasury-transfer-btn').forEach((btn) => btn.addEventListener('click', () => { supplierModal(`<p>تحويل النقدية بين الدرج والخزينة والبنك مع ترحيل قيد مزدوج فوري.</p><label>من حساب<select name="fromAccount" required><option value="1010">درج النقدية (1010)</option><option value="1015">الخزينة الرئيسية (1015)</option><option value="1020">البنك والتحصيل الإلكتروني (1020)</option></select></label><label>إلى حساب<select name="toAccount" required><option value="1015">الخزينة الرئيسية (1015)</option><option value="1020">البنك والتحصيل الإلكتروني (1020)</option><option value="1010">درج النقدية (1010)</option></select></label><label>المبلغ (${state.data.company.currency})<input name="amount" inputmode="decimal" required></label><label>ملاحظات (اختياري)<input name="notes" maxlength="300" placeholder="مثال: توريد نقدية نهاية اليوم"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'treasury-transfer-form', '/api/accounting/treasury-transfer', (data) => ({ ...data, amount: toMinor(data.amount, decimals) }), 'تم تحويل النقدية وترحيل القيد المحاسبي بنجاح'); })); document.querySelectorAll('#close-shift-btn').forEach((btn) => btn.addEventListener('click', () => { const bookLabel = state.data.drawerBookBalance ? money(state.data.drawerBookBalance) : '—'; supplierModal(`<p>الرصيد الدفتري الحالي لدرج النقدية (1010): <strong>${bookLabel}</strong>. أدخل النقدية الفعلية المعدودة في الدرج لإثبات التطابق أو تسوية العجز/الزيادة محاسبيًا.</p><label>النقدية الفعلية في الدرج (${state.data.company.currency})<input name="actualCashAmount" inputmode="decimal" required></label><label>ملاحظات التقفيل (اختياري)<input name="notes" maxlength="300"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'shift-close-form', '/api/accounting/shift-close', (data) => ({ ...data, actualCashAmount: toMinor(data.actualCashAmount, decimals) }), 'تم تقفيل الوردية وتسوية رصيد درج النقدية'); })); document.querySelectorAll('.close-period-btn').forEach((btn) => btn.addEventListener('click', async () => { if (!window.confirm(`هل تريد إقفال الفترة المحاسبية (${btn.dataset.periodName}) نهائيًا؟ لا يمكن تسجيل قيود بتاريخ قديم داخلها بعد الإقفال.`)) return; btn.disabled = true; try { await api('/api/accounting/periods/close', { method: 'POST', body: JSON.stringify({ periodId: btn.dataset.periodId }) }); await loadData(state.data.selectedStoreId); render(); toast('تم إقفال الفترة المحاسبية بنجاح'); } catch (error) { toast(error.message, 'error'); btn.disabled = false; } })); }
function backupView() {
  const daily = state.dailyBackups;
  const backupsList = daily?.backups ?? [];
  const formatBytes = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  };
  return `<div class="page-heading-row"><div><p class="page-lead">نظام الحماية المزدوج: نسخ احتياطي يومي تلقائي كل ليلة على الجهاز + إمكانية تصدير واستعادة نسخة مشفرة بكلمة مرور.</p></div><button type="button" class="button button-primary button-sm" id="run-daily-backup-now">${icon('plus', 16)} حفظ نسخة يومية فورية الآن</button></div>
    <section class="panel compact-panel">
      <div class="panel-heading"><div><h3>النسخ الاحتياطي اليومي التلقائي (حماية تلقائية كل ليلة)</h3><p>يقوم النظام بحفظ نسخة كاملة من قاعدة البيانات تلقائيًا كل يوم والاحتفاظ بآخر ${daily?.retentionDays ?? 30} يومًا للرجوع إليها في أي وقت.</p></div><span class="status-pill status-complete">مفعّل تلقائيًا</span></div>
      ${backupsList.length ? `<div class="table-scroll"><table class="compact-table"><thead><tr><th>تاريخ النسخة اليومية</th><th>اسم الملف</th><th>الحجم</th><th>وقت الحفظ</th><th>تحميل</th></tr></thead><tbody>${backupsList.map((item) => `<tr><td><strong>${escapeHtml(item.date)}</strong></td><td><span class="sku-code">${escapeHtml(item.filename)}</span></td><td>${formatBytes(item.sizeBytes)}</td><td>${new Date(item.createdAt).toLocaleString('ar-EG')}</td><td><a class="text-action" href="/api/backups/daily/${encodeURIComponent(item.filename)}" download>تنزيل النسخة ↓</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">جاري تجهيز سجل النسخ اليومية التلقائية...</div>'}
    </section>
    <div class="analytics-two-col">
      <section class="panel compact-panel"><div class="panel-heading"><div><h3>تصدير نسخة احتياطية مشفرة (.rfbackup)</h3><p>نسخة خارجية مشفرة بكلمة مرور لحفظها على فلاشة أو سحابة خارجية.</p></div></div><div class="empty-row">احفظ كلمة المرور في مكان آمن؛ لا يمكن فك تشفير النسخة بدونها.</div><form id="backup-export-form" class="form-stack"><label>كلمة مرور للتشفير<input name="passphrase" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><label>أكد كلمة المرور<input name="confirmPassphrase" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><button class="button button-primary" type="submit">تنزيل نسخة احتياطية</button></form></section>
      <section class="panel compact-panel"><div class="panel-heading"><div><h3>استعادة نسخة مشفرة</h3><p>سيتم استبدال بيانات المحل الحالية وإعادة تشغيل النظام.</p></div></div><form id="backup-restore-form" class="form-stack"><label>ملف النسخة<input name="archive" type="file" accept=".rfbackup,application/octet-stream" required></label><label>كلمة مرور النسخة<input name="passphrase" type="password" minlength="12" maxlength="256" autocomplete="current-password" required></label><label><input name="confirmReplace" type="checkbox" required> أفهم أن الاستعادة ستستبدل البيانات.</label><button class="button button-danger" type="submit">استعادة النسخة</button></form></section>
    </div>`;
}

function bindBackups() {
  if (!state.dailyBackupsKey) {
    state.dailyBackupsKey = 'loaded';
    void api('/api/backups/daily').then((res) => { state.dailyBackups = res; render(); }).catch(() => {});
  }
  document.querySelector('#run-daily-backup-now')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api('/api/backups/daily/run-now', { method: 'POST', body: '{}' });
      state.dailyBackups = { ...(state.dailyBackups ?? { retentionDays: 30 }), backups: res.backups ?? [] };
      render();
      toast('تم حفظ النسخة الاحتياطية اليومية بنجاح');
    } catch (error) { toast(error.message, 'error'); btn.disabled = false; }
  });
  document.querySelector('#backup-export-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if (data.passphrase !== data.confirmPassphrase) { toast('\u0643\u0644\u0645\u062a\u0627 \u0627\u0644\u0645\u0631\u0648\u0631 \u063a\u064a\u0631 \u0645\u062a\u0637\u0627\u0628\u0642\u062a\u064a\u0646', 'error'); return; }
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      requireMutationConfirmation('تنزيل النسخة الاحتياطية');
      const response = await fetch('/api/backups/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: data.passphrase }) });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || 'Backup export failed'); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'retailos.rfbackup'; link.click(); URL.revokeObjectURL(url); form.reset(); toast('\u062a\u0645 \u062a\u0646\u0632\u064a\u0644 \u0627\u0644\u0646\u0633\u062e\u0629 \u0627\u0644\u0645\u0634\u0641\u0631\u0629');
    } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
  });
  document.querySelector('#backup-restore-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    if (!window.confirm('\u0633\u064a\u062a\u0645 \u0627\u0633\u062a\u0628\u062f\u0627\u0644 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062d\u0644 \u0627\u0644\u062d\u0627\u0644\u064a\u0629 \u0648\u0625\u0639\u0627\u062f\u0629 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0646\u0638\u0627\u0645. \u0647\u0644 \u062a\u0631\u064a\u062f \u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629\u061f')) return;
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      const bytes = new TextEncoder().encode(data.passphrase); let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const encodedPassphrase = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const response = await fetch('/api/backups/restore', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodedPassphrase, 'X-RetailOS-Restore-Confirm': 'replace' }, body: data.archive });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || 'Restore failed'); }
      toast('\u0628\u062f\u0623\u062a \u0627\u0633\u062a\u0639\u0627\u062f\u0629 \u0627\u0644\u0646\u0633\u062e\u0629. \u0627\u0646\u062a\u0638\u0631 \u0625\u0639\u0627\u062f\u0629 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0646\u0638\u0627\u0645.'); form.reset();
    } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
  });
}

function computePresetRange(preset) {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (preset === 'today') return { from: to, to };
  if (preset === '7d') { const d = new Date(now); d.setUTCDate(d.getUTCDate() - 6); return { from: d.toISOString().slice(0, 10), to }; }
  if (preset === '30d') { const d = new Date(now); d.setUTCDate(d.getUTCDate() - 29); return { from: d.toISOString().slice(0, 10), to }; }
  if (preset === 'month') return { from: `${to.slice(0, 7)}-01`, to };
  if (preset === 'year') return { from: `${to.slice(0, 4)}-01-01`, to };
  return { from: to, to };
}

function bindTopProducts() {
  document.querySelector('#analytics-section-select')?.addEventListener('change', (event) => {
    state.analyticsSection = event.currentTarget.value;
    render();
  });
  document.querySelectorAll('[data-analytics-section]').forEach((btn) => btn.addEventListener('click', () => {
    state.analyticsSection = btn.dataset.analyticsSection;
    render();
  }));
  document.querySelectorAll('[data-analytics-range]').forEach((btn) => btn.addEventListener('click', () => {
    state.analyticsRange = btn.dataset.analyticsRange;
    const range = computePresetRange(btn.dataset.analyticsRange);
    state.analyticsFrom = range.from;
    state.analyticsTo = range.to;
    state.productStats = null;
    state.supplierStats = null;
    state.analyticsKey = null;
    render();
  }));
  document.querySelector('#analytics-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get('from') ?? ''), to = String(data.get('to') ?? '');
    if (from > to) { toast('تاريخ البداية لازم يكون قبل تاريخ النهاية', 'error'); return; }
    state.analyticsRange = 'custom';
    state.analyticsFrom = from;
    state.analyticsTo = to;
    state.productStats = null;
    state.supplierStats = null;
    state.analyticsKey = null;
    render();
  });
  if (!state.growthForecast) void loadGrowthForecast();

  document.querySelector('#growth-view-3m')?.addEventListener('click', () => {
    state.growthViewMode = '3m';
    render();
  });
  document.querySelector('#growth-view-6m')?.addEventListener('click', () => {
    state.growthViewMode = '6m';
    render();
  });
  document.querySelector('#growth-view-year')?.addEventListener('click', () => {
    state.growthViewMode = 'year';
    render();
  });
  document.querySelector('#growth-year-select')?.addEventListener('change', async (e) => {
    state.growthSelectedYear = Number(e.target.value);
    state.growthViewMode = 'year';
    await loadGrowthForecast(state.growthSelectedYear, 1);
  });

  const growthMonthPicker = document.querySelector('#growth-month-picker');
  growthMonthPicker?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    const [y, m] = val.split('-');
    state.growthSelectedYear = Number(y);
    void loadGrowthForecast(y, m);
  });

  document.querySelectorAll('[data-chart-ym], .view-growth-month-btn').forEach((elem) => {
    elem.addEventListener('click', () => {
      const ym = elem.dataset.chartYm || elem.dataset.growthYm;
      if (!ym) return;
      const [y, m] = ym.split('-');
      state.growthSelectedYear = Number(y);
      void loadGrowthForecast(y, m);
    });
  });
  const today = new Date().toISOString().slice(0, 10);
  state.analyticsTo ??= today;
  if (!state.analyticsFrom) { const start = new Date(); start.setUTCDate(start.getUTCDate() - 29); state.analyticsFrom = start.toISOString().slice(0, 10); }
  const key = `${state.data.selectedStoreId}:${state.analyticsFrom}:${state.analyticsTo}`;
  if (state.analyticsKey === key) return;
  state.analyticsKey = key;
  const query = new URLSearchParams({ storeId: state.data.selectedStoreId, from: state.analyticsFrom, to: state.analyticsTo });
  const canViewPurchases = state.data.capabilities.canViewAccounting;
  void Promise.all([api(`/api/reports/top-products?${query}`), canViewPurchases ? api(`/api/reports/purchases?${query}`) : Promise.resolve(null)]).then(([products, suppliers]) => {
    state.productStats = products;
    state.supplierStats = suppliers ?? { topBySpend: null, topByInvoices: null, suppliers: [] };
    render();
  }).catch((error) => {
    state.analyticsKey = null;
    toast(error.message, 'error');
  });
}
function bindProfitLoss() {
  bindAccounting();
  document.querySelector('#pl-section-select')?.addEventListener('change', (event) => {
    state.plSection = event.currentTarget.value;
    render();
  });
  document.querySelectorAll('[data-pl-section]').forEach((btn) => btn.addEventListener('click', () => {
    state.plSection = btn.dataset.plSection;
    render();
  }));
  document.querySelector('#btn-pl-to-financial-map')?.addEventListener('click', () => {
    state.page = 'financial-map';
    render();
  });
  const today = new Date().toISOString().slice(0, 10);
  state.reportFrom ??= today;
  state.reportTo ??= today;
  const load = async (from, to) => {
    state.reportFrom = from;
    state.reportTo = to;
    const key = `${state.data.selectedStoreId}:${from}:${to}`;
    if (state.reportKey === key) return;
    state.reportKey = key;
    try {
      const query = new URLSearchParams({ from, to, storeId: state.data.selectedStoreId });
      state.report = await api(`/api/reports/profit-loss?${query}`);
      render();
    } catch (error) {
      state.reportKey = null;
      toast(error.message, 'error');
    }
  };
  document.querySelectorAll('[data-pl-range]').forEach((btn) => btn.addEventListener('click', () => {
    state.plRange = btn.dataset.plRange;
    const range = computePresetRange(btn.dataset.plRange);
    state.reportKey = null;
    void load(range.from, range.to);
  }));
  document.querySelector('#profit-loss-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.plRange = 'custom';
    const from = document.querySelector('#report-from').value;
    const to = document.querySelector('#report-to').value;
    state.reportKey = null;
    void load(from, to);
  });
  if (!state.report || state.reportKey !== `${state.data.selectedStoreId}:${state.reportFrom}:${state.reportTo}`) void load(state.reportFrom, state.reportTo);
}

function handleShortcuts(event) {
  if (event.key === 'F2') { event.preventDefault(); state.page = 'pos'; state.query = ''; render(); }
  document.addEventListener('keydown', handleShortcuts, { once: true });
}

function bindLocalSearch() {
  document.querySelector('.local-search')?.addEventListener('input', (event) => {
    state.query = event.target.value;
    const cursor = event.target.selectionStart;
    render();
    const next = document.querySelector('.local-search');
    next?.focus(); next?.setSelectionRange(cursor, cursor);
  });
}

function openModelVariantStockModal({ mode }) {
  const products = state.data.products.filter((p) => p.itemKind === 'PRODUCT' && p.isActive && p.variants.some((v) => v.isActive && (mode === 'adjust' ? true : BigInt(v.quantity) > 0n)));
  if (!products.length) {
    toast(mode === 'adjust' ? 'لا توجد أصناف لتسوية الجرد' : 'لا توجد أصناف بها رصيد متاح في الفرع الحالي', 'error');
    return;
  }
  const decimals = currencyDecimals(state.data.company.currency);
  const otherStores = state.data.stores.filter((s) => s.id !== state.data.selectedStoreId);
  const buildVariantOptionsHtml = (product) => {
    const variants = (product?.variants ?? []).filter((v) => v.isActive && (mode === 'adjust' ? true : BigInt(v.quantity) > 0n));
    return variants.map((v) => {
      const attrLabel = Object.entries(v.attributes ?? {}).map(([k, val]) => `${product.options?.find((o) => o.key === k)?.name ?? k}: ${val}`).join(' · ') || 'النسخة الأساسية';
      return `<option value="${v.id}" data-max-qty="${v.quantity}">${escapeHtml(attrLabel)} (${escapeHtml(v.sku)}) — الرصيد الحالي: ${v.quantity} قطعة</option>`;
    }).join('');
  };
  const firstProduct = products[0];
  const modelSelectorHtml = `<label>الموديل / المنتج الأساسي<select id="stock-modal-product-select">${products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.sku)})</option>`).join('')}</select></label><label>اللون والمقاس الفرعي (SKU)<select name="variantId" id="stock-modal-variant-select" required>${buildVariantOptionsHtml(firstProduct)}</select></label>`;
  if (mode === 'transfer') {
    supplierModal(`<p>التحويل من الفرع الحالي: <strong>${escapeHtml(state.data.stores.find((s) => s.id === state.data.selectedStoreId)?.name ?? '')}</strong></p><label>إلى الفرع<select name="toStoreId" required>${otherStores.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></label>${modelSelectorHtml}<label>الكمية المحولة<input name="quantity" type="number" min="1" step="1" value="1" required></label><input type="hidden" name="fromStoreId" value="${state.data.selectedStoreId}">`, 'transfer-form', '/api/inventory/transfer', (d) => d, 'تم تحويل المخزون بين الفروع بنجاح');
  } else if (mode === 'damage') {
    supplierModal(`<p>سيتم خصم الكمية التالفة من المخزون وترحيل تكلفتها المرجحة كخسائر وتوالف مخزون (5090).</p>${modelSelectorHtml}<label>الكمية التالفة<input name="quantity" type="number" min="1" step="1" value="1" required></label><label>سبب الإعدام / التلف<input name="reason" maxlength="300" placeholder="مثال: كسر أثناء النقل أو عيب صناعة"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'damage-form', '/api/inventory/damage', (d) => d, 'تم تسجيل التالف وترحيل القيد المحاسبي');
  } else {
    supplierModal(`<p>أدخل الرصيد الفعلي الجديد بعد الجرد؛ سيقوم النظام بحساب الفرق وترحيل قيد التسوية تلقائيًا.</p>${modelSelectorHtml}<label>الرصيد الفعلي الجديد (قطعة)<input name="targetQuantity" type="number" min="0" step="1" required></label><label>تكلفة الوحدة في حالة الزيادة (${state.data.company.currency} - اختياري)<input name="unitCost" inputmode="decimal"></label><label>سبب التسوية<input name="reason" maxlength="300" placeholder="مثال: جرد دوري للفرع"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'adjust-form', '/api/inventory/adjust', (d) => ({ ...d, unitCost: d.unitCost ? toMinor(d.unitCost, decimals) : undefined }), 'تم تسوية رصيد المخزون وترحيل القيد المحاسبي');
  }
  const prodSelect = document.querySelector('#stock-modal-product-select');
  const varSelect = document.querySelector('#stock-modal-variant-select');
  prodSelect?.addEventListener('change', () => {
    const selectedProduct = products.find((p) => p.id === prodSelect.value);
    if (varSelect && selectedProduct) varSelect.innerHTML = buildVariantOptionsHtml(selectedProduct);
  });
}

function showBarcodeLabelsModal({ product = null, purchase = null } = {}) {
  const modal = getModalRoot();
  const storeName = state.data.company.name || 'المتجر';
  const rowsData = [];
  if (purchase) {
    for (const item of purchase.items ?? []) {
      const matchedProduct = state.data.products.find((p) => p.variants.some((v) => v.sku === item.sku));
      const matchedVariant = matchedProduct?.variants.find((v) => v.sku === item.sku);
      const attrLabel = matchedVariant
        ? Object.entries(matchedVariant.attributes ?? {}).map(([k, val]) => `${matchedProduct.options?.find((o) => o.key === k)?.name ?? k}: ${val}`).join(' · ')
        : '';
      const code = matchedVariant?.barcode || matchedVariant?.sku || item.sku;
      const retailPriceText = matchedVariant ? money(matchedVariant.price) : '';
      rowsData.push({
        id: item.id,
        modelName: matchedProduct?.name || item.productName,
        modelSku: matchedProduct?.sku || item.sku,
        subLabel: attrLabel || 'النسخة الأساسية',
        sku: item.sku,
        barcode: code,
        priceText: retailPriceText,
        defaultCopies: Math.max(0, Number(item.quantity) || 1),
        stockQty: matchedVariant?.quantity ?? item.quantity,
      });
    }
  } else if (product) {
    const activeVariants = (product.variants ?? []).filter((v) => v.isActive);
    activeVariants.forEach((v, idx) => {
      const attrLabel = Object.entries(v.attributes ?? {}).map(([k, val]) => `${product.options?.find((o) => o.key === k)?.name ?? k}: ${val}`).join(' · ') || 'النسخة الأساسية';
      const code = v.barcode || v.sku || generateEan13Barcode(v.sku, idx + 1);
      rowsData.push({
        id: v.id,
        modelName: product.name,
        modelSku: product.sku,
        subLabel: attrLabel,
        sku: v.sku,
        barcode: code,
        priceText: money(v.price),
        defaultCopies: Number(v.quantity) > 0 ? Number(v.quantity) : 1,
        stockQty: v.quantity,
      });
    });
  }
  const title = purchase
    ? `طباعة استيكرات باركود فاتورة الشراء (${purchase.invoiceNumber || purchase.id.slice(0, 8)})`
    : `طباعة استيكرات باركود العلب — ${product?.name ?? ''}`;
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal barcode-print-modal" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">نظام الباركود واستيكرات العلب الحرارية</span><h2>${escapeHtml(title)}</h2></div><button type="button" class="modal-close" data-close-barcode-modal>×</button></div><div class="matrix-quick-toolbar"><span>حدد عدد الاستيكرات المطلوب طباعتها لكل لون ومقاس:</span><div class="matrix-quick-actions"><button type="button" class="date-preset-chip" data-label-preset="one">استيكر واحد لكل مقاس (1)</button><button type="button" class="date-preset-chip" data-label-preset="stock">بعدد الرصيد/الفاتورة الفعلي</button><button type="button" class="date-preset-chip" data-label-preset="zero">تصفير الكل</button></div></div><div class="table-scroll" style="max-height:220px"><table class="variant-matrix-table compact-table"><thead><tr><th>الموديل</th><th>اللون والمقاس</th><th>كود الفرع (SKU)</th><th>الباركود</th><th>السعر</th><th>عدد الاستيكرات</th></tr></thead><tbody>${rowsData.map((r, idx) => `<tr data-label-row="${idx}"><td><strong>${escapeHtml(r.modelName)}</strong></td><td>${escapeHtml(r.subLabel)}</td><td><span class="sku-code">${escapeHtml(r.sku)}</span></td><td><span class="sku-code">${escapeHtml(r.barcode)}</span></td><td>${escapeHtml(r.priceText)}</td><td><input type="number" min="0" max="200" step="1" data-label-copies="${idx}" value="${r.defaultCopies}" style="width:82px;text-align:center;font-weight:800"></td></tr>`).join('')}</tbody></table></div><div class="barcode-preview-header"><strong>معاينة ملصقات الباركود الجاهزة للطباعة</strong><small id="barcode-total-count"></small></div><div id="barcode-sheet-preview" class="barcode-labels-sheet"></div><div class="modal-actions"><button type="button" class="button button-secondary" data-close-barcode-modal>إغلاق</button><button type="button" class="button button-primary" id="print-barcode-sheet-btn">طباعة الاستيكرات الآن</button></div></section></div>`;
  modal.querySelectorAll('[data-close-barcode-modal]').forEach((b) => b.addEventListener('click', () => { modal.innerHTML = ''; }));
  const sheet = modal.querySelector('#barcode-sheet-preview');
  const countEl = modal.querySelector('#barcode-total-count');
  const renderLabelsPreview = () => {
    const cards = [];
    modal.querySelectorAll('[data-label-copies]').forEach((input) => {
      const idx = Number(input.dataset.labelCopies);
      const copies = Math.min(200, Math.max(0, Math.floor(Number(input.value) || 0)));
      const item = rowsData[idx];
      if (!item || copies <= 0) return;
      const svg = renderBarcodeSvg(item.barcode);
      for (let c = 0; c < copies; c += 1) {
        cards.push(`<article class="barcode-sticker-card"><div class="sticker-top"><span>${escapeHtml(storeName)}</span><strong>${escapeHtml(item.priceText)}</strong></div><div class="sticker-model">${escapeHtml(item.modelName)}</div><div class="sticker-variant">${escapeHtml(item.subLabel)}</div><div class="sticker-bars">${svg}</div><div class="sticker-code"><span>${escapeHtml(item.sku)}</span><small>${escapeHtml(item.barcode)}</small></div></article>`);
      }
    });
    countEl.textContent = `إجمالي الملصقات: ${cards.length} استيكر`;
    sheet.innerHTML = cards.length ? cards.join('') : '<div class="empty-row">حدد عدد استيكرات أكبر من صفر لمعاينة الطباعة.</div>';
  };
  modal.querySelectorAll('[data-label-copies]').forEach((input) => input.addEventListener('input', renderLabelsPreview));
  modal.querySelectorAll('[data-label-preset]').forEach((btn) => btn.addEventListener('click', () => {
    const preset = btn.dataset.labelPreset;
    modal.querySelectorAll('[data-label-copies]').forEach((input) => {
      const idx = Number(input.dataset.labelCopies);
      const item = rowsData[idx];
      if (preset === 'one') input.value = '1';
      else if (preset === 'stock') input.value = String(Math.max(0, Number(purchase ? item.defaultCopies : item.stockQty) || 0));
      else input.value = '0';
    });
    renderLabelsPreview();
  }));
  modal.querySelector('#print-barcode-sheet-btn')?.addEventListener('click', () => window.print());
  renderLabelsPreview();
}

function bindStoreStockActions() {
  document.querySelector('#new-store-btn')?.addEventListener('click', () => supplierModal('<label>اسم الفرع الجديد<input name="name" required minlength="2" maxlength="100" placeholder="مثال: فرع المعادي"></label><label>كود الفرع<input name="code" required minlength="2" maxlength="20" pattern="[A-Za-z0-9_-]+" placeholder="MAADI"></label><label>العنوان (اختياري)<input name="address" maxlength="240"></label><label>الهاتف (اختياري)<input name="phone" maxlength="40"></label>', 'store-form', '/api/stores', (d) => d, 'تم إضافة الفرع الجديد بنجاح'));
  document.querySelector('#transfer-stock-btn')?.addEventListener('click', () => openModelVariantStockModal({ mode: 'transfer' }));
  document.querySelector('#record-damage-btn')?.addEventListener('click', () => openModelVariantStockModal({ mode: 'damage' }));
  document.querySelector('#adjust-stock-btn')?.addEventListener('click', () => openModelVariantStockModal({ mode: 'adjust' }));
}

function bindProducts() {
  bindLocalSearch();
  bindStoreStockActions();
  const open = () => showProductModal();
  document.querySelector('#new-product')?.addEventListener('click', open);
  document.querySelector('#add-category')?.addEventListener('click', () => showCategoryModal());
  document.querySelector('#empty-new-product')?.addEventListener('click', open);
  document.querySelectorAll('.product-print-labels').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.productId);
    if (product) showBarcodeLabelsModal({ product });
  }));
  document.querySelectorAll('.product-edit').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.productId);
    if (product) showProductEditModal(product);
  }));
  document.querySelectorAll('.product-delete').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/products/${encodeURIComponent(button.dataset.productId)}`, { method: 'DELETE' });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
      toast('تم حذف المنتج من قائمة البيع مع الاحتفاظ بسجله وفواتيره');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  }));
}

function showProductEditModal(product) {
  const modal = getModalRoot();
  const currency = state.data.company.currency;
  const quickColors = ['أسود', 'أبيض', 'كحلي', 'بيج', 'رمادي', 'بني', 'هافان', 'زيتي', 'جملي', 'نبيتي'];
  const quickSizes = ['36, 37, 38, 39, 40, 41', '40, 41, 42, 43, 44, 45', '41, 42, 43, 44, 45, 46', 'S, M, L, XL, XXL'];
  const categoryChoices = state.data.categories.map((category) => `<option value="${category.id}" ${category.id === product.categoryId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
  const activeExisting = product.variants.filter((variant) => variant.isActive);
  const defaultPrice = activeExisting[0] ? decimalPrice(activeExisting[0].price) : '0';
  const defaultReorder = activeExisting[0]?.reorderPoint ?? '3';
  const initialOptions = (product.options?.length ? product.options : []).map((opt) => ({ key: opt.key, name: opt.name, values: [...(opt.values ?? [])] }));

  modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="product-edit-title" style="margin:20px auto;max-width:calc(100vw - 32px);"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">الكتالوج الموحد — توسيع وتعديل الموديل</span><h2 id="product-edit-title">تعديل الموديل: ${escapeHtml(product.name)} (${escapeHtml(product.sku)})</h2></div><button class="modal-close" data-close-modal>×</button></div><form id="product-edit-form" class="form-stack modal-form"><div class="form-grid"><label>اسم الموديل / المنتج<input name="name" required minlength="2" maxlength="120" value="${escapeHtml(product.name)}"></label><label>كود الموديل الأساسي<input name="sku" required maxlength="64" value="${escapeHtml(product.sku)}"></label></div><div class="form-grid"><label>الفئة<select name="categoryId"><option value="">بدون فئة</option>${categoryChoices}</select></label><label>الماركة / المصنع<input name="brand" maxlength="100" value="${escapeHtml(product.brand ?? '')}"></label></div><div class="form-grid" style="background:var(--surface-soft);padding:14px;border-radius:12px;border:1px solid var(--line);margin:4px 0;"><label style="font-weight:750;">سعر البيع الجديد للموديل (${currency})<input name="baseRetailPrice" id="edit-modal-base-price" inputmode="decimal" value="${escapeHtml(defaultPrice)}" placeholder="مثال: 350.00" style="font-weight:800;font-size:15px;color:var(--purple);"><small style="color:var(--muted);font-size:11px;">تحديث وتعديل سعر البيع وتطبيقه على كافة المقاسات والألوان</small></label><div style="display:flex;align-items:flex-end;"><button type="button" class="button button-secondary" id="apply-price-to-all-variants" style="height:42px;width:100%;font-weight:750;">تطبيق هذا السعر على كل المقاسات</button></div></div><div class="form-grid"><label>رابط الصورة<input name="imagePath" type="url" maxlength="300" value="${escapeHtml(product.imagePath ?? '')}"></label><label>وصف الموديل<input name="description" maxlength="2000" value="${escapeHtml(product.description ?? '')}"></label></div>
  ${initialOptions.length ? `<div class="variant-options-section"><div><strong>إضافة ألوان أو مقاسات جديدة لهذا الموديل:</strong></div><div class="model-presets-bar"><span class="preset-label">+ لون جديد:</span>${quickColors.map((c) => `<button type="button" class="color-quick-chip" data-edit-add-color="${c}">+ ${c}</button>`).join('')}</div><div class="model-presets-bar"><span class="preset-label">+ مقاسات سريعة:</span>${quickSizes.map((s) => `<button type="button" class="date-preset-chip" data-edit-add-sizes="${s}">+ (${s})</button>`).join('')}</div><div id="edit-option-rows" class="form-stack">${initialOptions.map((opt) => `<div class="variant-option-row" data-edit-option-key="${escapeHtml(opt.key)}"><input data-edit-option-name value="${escapeHtml(opt.name)}" readonly><input data-edit-option-values value="${escapeHtml(opt.values.join(', '))}" placeholder="القيم مفصولة بفواصل"></div>`).join('')}</div></div>` : ''}
  <div class="matrix-quick-toolbar"><span>الفروع الحالية والجديدة التابعة للموديل (<strong>${activeExisting.length}</strong> فرع مسجل)</span><div class="matrix-quick-actions"><button type="button" class="date-preset-chip" id="edit-generate-barcodes">توليد باركود تلقائي للفروع بدون باركود</button><button type="button" class="date-preset-chip" id="edit-open-print-labels">طباعة استيكرات الباركود</button></div></div>
  <div class="table-scroll"><table class="variant-matrix-table zebra-table"><thead><tr><th>متاحة</th><th>اللون والمقاس الفرعي</th><th>كود الفرع (SKU)</th><th>الباركود</th><th>السعر (${currency})</th><th>حد الطلب</th></tr></thead><tbody id="edit-existing-tbody">${activeExisting.map((variant) => `<tr data-variant-id="${variant.id}" data-variant-attrs="${escapeHtml(JSON.stringify(variant.attributes ?? {}))}"><td><input data-edit-active type="checkbox" checked aria-label="إبقاء التركيبة متاحة"></td><td><strong>${escapeHtml(formatVariantAttributes(product, variant.attributes, product.name))}</strong></td><td><input data-edit-sku maxlength="64" required value="${escapeHtml(variant.sku)}"></td><td><input data-edit-barcode maxlength="64" value="${escapeHtml(variant.barcode ?? '')}" placeholder="باركود العلبة"></td><td><input data-edit-price inputmode="decimal" required value="${escapeHtml(decimalPrice(variant.price))}"></td><td><input data-edit-reorder type="number" min="0" step="1" required value="${escapeHtml(variant.reorderPoint)}"></td></tr>`).join('')}</tbody><tbody id="edit-generated-tbody"></tbody></table></div><div id="new-variant-rows" class="form-stack"></div>${product.options?.length ? '<button type="button" class="button button-secondary button-sm" id="add-edit-variant">+ إضافة فرع مفرد يدويًا</button>' : ''}<div class="modal-actions"><button type="button" class="button button-secondary" data-close-modal>إلغاء</button><button type="submit" class="button button-primary">حفظ التعديلات والفروع الجديدة</button></div></form></section></div>`;
  modal.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { modal.innerHTML = ''; }));
  modal.querySelector('#apply-price-to-all-variants')?.addEventListener('click', () => {
    const val = modal.querySelector('#edit-modal-base-price')?.value.trim();
    if (!val) { toast('أدخل السعر الجديد أولاً', 'error'); return; }
    modal.querySelectorAll('[data-edit-price], [data-new-combo-price], [data-new-price]').forEach((input) => {
      input.value = val;
    });
    toast(`تم تطبيق السعر (${val} ${currency}) على كافة المقاسات`);
  });
  const generatedTbody = modal.querySelector('#edit-generated-tbody');
  const editOptionRows = modal.querySelector('#edit-option-rows');

  const syncExpandedVariants = () => {
    if (!editOptionRows) return;
    const baseSku = modal.querySelector('[name="sku"]').value.trim() || product.sku;
    const updatedOptions = [...editOptionRows.querySelectorAll('[data-edit-option-key]')].map((row) => {
      const key = row.dataset.editOptionKey;
      const name = row.querySelector('[data-edit-option-name]').value.trim();
      const origValues = product.options?.find((o) => o.key === key)?.values ?? [];
      const typedValues = row.querySelector('[data-edit-option-values]').value.split(/[,،]/).map((v) => v.trim()).filter(Boolean);
      const merged = [...origValues];
      for (const v of typedValues) if (!merged.includes(v)) merged.push(v);
      return { key, name, values: merged };
    });
    const existingKeys = new Set(product.variants.map((v) => JSON.stringify(Object.fromEntries(updatedOptions.map((o) => [o.key, (v.attributes ?? {})[o.key]])))));
    const usedSkus = new Set([...modal.querySelectorAll('[data-edit-sku]')].map((el) => el.value.trim().toLowerCase()));
    const usedBarcodes = new Set([...modal.querySelectorAll('[data-edit-barcode]')].map((el) => el.value.trim()).filter(Boolean));
    const savedNew = new Map([...generatedTbody.querySelectorAll('[data-new-combo-key]')].map((tr) => [tr.dataset.newComboKey, {
      enabled: tr.querySelector('[data-new-combo-enabled]').checked,
      sku: tr.querySelector('[data-new-combo-sku]').value,
      barcode: tr.querySelector('[data-new-combo-barcode]').value,
      price: tr.querySelector('[data-new-combo-price]').value,
      reorder: tr.querySelector('[data-new-combo-reorder]').value,
    }]));
    const combos = [];
    const expand = (pos, attrs) => {
      if (pos === updatedOptions.length) { combos.push(attrs); return; }
      const opt = updatedOptions[pos];
      for (const val of opt.values) expand(pos + 1, { ...attrs, [opt.key]: val });
    };
    if (updatedOptions.length) expand(0, {});
    const newCombos = combos.filter((attrs) => !existingKeys.has(JSON.stringify(attrs)));
    generatedTbody.innerHTML = newCombos.map((attrs, idx) => {
      const comboKey = JSON.stringify(attrs);
      const prev = savedNew.get(comboKey);
      const label = Object.entries(attrs).map(([k, val]) => `${updatedOptions.find((o) => o.key === k)?.name ?? k}: ${val}`).join(' · ');
      const sku = prev?.sku || buildSemanticVariantSku(baseSku, attrs, activeExisting.length + idx, usedSkus);
      usedSkus.add(sku.toLowerCase());
      const barcode = prev?.barcode ?? generateEan13Barcode(sku, activeExisting.length + idx + 1, usedBarcodes);
      return `<tr class="new-expanded-variant-row" data-new-combo-key="${escapeHtml(comboKey)}"><td><input data-new-combo-enabled type="checkbox" ${prev?.enabled === false ? '' : 'checked'}></td><td><span class="kpi-tag kpi-tag-teal">جديد</span> <strong>${escapeHtml(label)}</strong></td><td><input data-new-combo-sku maxlength="64" required value="${escapeHtml(sku)}"></td><td><input data-new-combo-barcode maxlength="64" value="${escapeHtml(barcode)}"></td><td><input data-new-combo-price inputmode="decimal" required value="${escapeHtml(prev?.price ?? defaultPrice)}"></td><td><input data-new-combo-reorder type="number" min="0" step="1" required value="${escapeHtml(prev?.reorder ?? defaultReorder)}"></td></tr>`;
    }).join('');
  };

  editOptionRows?.addEventListener('input', syncExpandedVariants);
  modal.querySelectorAll('[data-edit-add-color]').forEach((btn) => btn.addEventListener('click', () => {
    if (!editOptionRows) return;
    const color = btn.dataset.editAddColor;
    const targetRow = [...editOptionRows.querySelectorAll('[data-edit-option-key]')].find((r) => COLOR_OPTION_NAMES.has(r.querySelector('[data-edit-option-name]').value.trim().toLowerCase())) ?? editOptionRows.firstElementChild;
    if (!targetRow) return;
    const input = targetRow.querySelector('[data-edit-option-values]');
    const vals = input.value.split(/[,،]/).map((v) => v.trim()).filter(Boolean);
    if (!vals.includes(color)) vals.push(color);
    input.value = vals.join(', ');
    syncExpandedVariants();
  }));
  modal.querySelectorAll('[data-edit-add-sizes]').forEach((btn) => btn.addEventListener('click', () => {
    if (!editOptionRows) return;
    const sizesToAdd = btn.dataset.editAddSizes.split(/[,،]/).map((v) => v.trim()).filter(Boolean);
    const targetRow = [...editOptionRows.querySelectorAll('[data-edit-option-key]')].find((r) => SIZE_OPTION_NAMES.has(r.querySelector('[data-edit-option-name]').value.trim().toLowerCase())) ?? editOptionRows.lastElementChild;
    if (!targetRow) return;
    const input = targetRow.querySelector('[data-edit-option-values]');
    const vals = input.value.split(/[,،]/).map((v) => v.trim()).filter(Boolean);
    for (const s of sizesToAdd) if (!vals.includes(s)) vals.push(s);
    input.value = vals.join(', ');
    syncExpandedVariants();
  }));
  modal.querySelector('#edit-generate-barcodes')?.addEventListener('click', () => {
    const usedBarcodes = new Set();
    modal.querySelectorAll('[data-edit-barcode], [data-new-combo-barcode]').forEach((el) => { if (el.value.trim()) usedBarcodes.add(el.value.trim()); });
    let seq = 1;
    modal.querySelectorAll('[data-edit-barcode]').forEach((el) => {
      if (!el.value.trim()) {
        const sku = el.closest('tr')?.querySelector('[data-edit-sku]')?.value || product.sku;
        el.value = generateEan13Barcode(sku, seq++, usedBarcodes);
      }
    });
    modal.querySelectorAll('[data-new-combo-barcode]').forEach((el) => {
      if (!el.value.trim()) {
        const sku = el.closest('tr')?.querySelector('[data-new-combo-sku]')?.value || product.sku;
        el.value = generateEan13Barcode(sku, seq++, usedBarcodes);
      }
    });
    toast('تم توليد أرقام باركود فريدة لجميع المقاسات والألوان');
  });

  const newVariantRows = modal.querySelector('#new-variant-rows');
  modal.querySelector('#add-edit-variant')?.addEventListener('click', () => {
    const row = document.createElement('div'); row.className = 'form-grid edit-new-variant';
    const currentOptions = editOptionRows ? [...editOptionRows.querySelectorAll('[data-edit-option-key]')].map((r) => ({ key: r.dataset.editOptionKey, name: r.querySelector('[data-edit-option-name]').value.trim(), values: r.querySelector('[data-edit-option-values]').value.split(/[,،]/).map((v) => v.trim()).filter(Boolean) })) : (product.options ?? []);
    const selectors = currentOptions.map((option) => `<label>${escapeHtml(option.name)}<select data-new-attribute="${escapeHtml(option.key)}">${option.values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}</select></label>`).join('');
    row.innerHTML = `${selectors}<label>كود النسخة<input data-new-sku required maxlength="64"></label><label>السعر (${currency})<input data-new-price inputmode="decimal" required value="${escapeHtml(defaultPrice)}"></label><label>حد الطلب<input data-new-reorder type="number" min="0" value="${escapeHtml(defaultReorder)}" required></label><button type="button" class="text-action" data-remove-new>حذف</button>`;
    row.querySelector('[data-remove-new]').addEventListener('click', () => row.remove()); newVariantRows.append(row);
  });
  modal.querySelector('#product-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const updatedOptions = editOptionRows ? [...editOptionRows.querySelectorAll('[data-edit-option-key]')].map((row) => {
        const key = row.dataset.editOptionKey;
        const name = row.querySelector('[data-edit-option-name]').value.trim();
        const origValues = product.options?.find((o) => o.key === key)?.values ?? [];
        const typedValues = row.querySelector('[data-edit-option-values]').value.split(/[,،]/).map((v) => v.trim()).filter(Boolean);
        const merged = [...origValues];
        for (const v of typedValues) if (!merged.includes(v)) merged.push(v);
        return { key, name, values: merged };
      }) : (product.options ?? []);
      const variants = [...form.querySelectorAll('[data-variant-id]')].filter((row) => row.querySelector('[data-edit-active]').checked).map((row) => ({
        id: row.dataset.variantId,
        sku: row.querySelector('[data-edit-sku]').value.trim(),
        barcode: row.querySelector('[data-edit-barcode]')?.value.trim() || null,
        attributes: product.variants.find((item) => item.id === row.dataset.variantId)?.attributes ?? {},
        retailPrice: toMinor(row.querySelector('[data-edit-price]').value, currencyDecimals(currency)),
        reorderPoint: row.querySelector('[data-edit-reorder]').value,
      }));
      for (const row of generatedTbody?.querySelectorAll('[data-new-combo-key]') ?? []) {
        if (!row.querySelector('[data-new-combo-enabled]')?.checked) continue;
        variants.push({
          sku: row.querySelector('[data-new-combo-sku]').value.trim(),
          barcode: row.querySelector('[data-new-combo-barcode]')?.value.trim() || null,
          attributes: JSON.parse(row.dataset.newComboKey),
          retailPrice: toMinor(row.querySelector('[data-new-combo-price]').value, currencyDecimals(currency)),
          reorderPoint: row.querySelector('[data-new-combo-reorder]').value,
        });
      }
      for (const row of newVariantRows?.querySelectorAll('.edit-new-variant') ?? []) variants.push({ sku: row.querySelector('[data-new-sku]').value.trim(), attributes: Object.fromEntries([...row.querySelectorAll('[data-new-attribute]')].map((select) => [select.dataset.newAttribute, select.value])), retailPrice: toMinor(row.querySelector('[data-new-price]').value, currencyDecimals(currency)), reorderPoint: row.querySelector('[data-new-reorder]').value });
      await api(`/api/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: JSON.stringify({ name: data.get('name'), sku: data.get('sku'), categoryId: data.get('categoryId') || null, description: data.get('description') || null, brand: data.get('brand') || null, imagePath: data.get('imagePath') || null, options: updatedOptions, variants }) });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
      toast('تم حفظ تعديلات الموديل والفروع الجديدة بنجاح');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
}

function showCategoryModal(onCreated = null) {
  const root = getModalRoot();
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop category-modal-overlay';
  overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="category-modal-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">الكتالوج</span><h2 id="category-modal-title">إضافة فئة</h2></div><button type="button" class="modal-close" data-close-category>×</button></div><form id="category-form" class="form-stack modal-form"><label>اسم الفئة<input name="name" required minlength="2" maxlength="100" autofocus></label><div class="modal-actions"><button type="button" class="button button-secondary" data-close-category>إلغاء</button><button type="submit" class="button button-primary">حفظ الفئة</button></div></form></section>`;
  root.append(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-close-category]').forEach((button) => button.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const name = new FormData(form).get('name');
      const result = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      const select = document.querySelector('#product-form select[name="categoryId"]');
      if (select) {
        select.innerHTML = `<option value="">بدون فئة</option>${state.data.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('')}`;
        select.value = result.id;
      }
      close();
      toast('تمت إضافة الفئة');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
}

function showProductModal() {
  const modal = getModalRoot();
  const currency = state.data.company.currency;
  const popularColors = ['أسود', 'أبيض', 'كحلي', 'بيج', 'رمادي', 'هافان', 'بني', 'زيتي', 'نبيتي'];
  const categoryChoices = state.data.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  modal.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="product-modal-title">
        <div class="modal-heading">
          <div>
            <h2 id="product-modal-title">إضافة منتج جديد للكتالوج</h2>
          </div>
          <button type="button" class="modal-close" data-close-modal aria-label="إغلاق">×</button>
        </div>

        <div class="product-kind-toggle">
          <button type="button" class="product-kind-btn active" data-kind-choice="MODEL">موديل (ألوان ومقاسات)</button>
          <button type="button" class="product-kind-btn" data-kind-choice="SINGLE">صنف عادي (مفرد)</button>
        </div>

        <form id="product-form" class="form-stack modal-form">
          <div class="form-grid">
            <label>اسم الموديل / المنتج
              <input name="name" required minlength="2" maxlength="120" placeholder="مثال: كوتشي ميلانو رانينج">
            </label>
            <label>كود الموديل الأساسي (SKU)
              <input name="sku" required maxlength="64" placeholder="MIL-205">
            </label>
          </div>

          <div class="form-grid">
            <label>الفئة
              <div class="category-select-row">
                <select name="categoryId">
                  <option value="">بدون فئة</option>
                  ${categoryChoices}
                </select>
                <button type="button" class="text-action" id="add-category-inline">فئة جديدة</button>
              </div>
            </label>
            <label>الماركة / الشركة (اختياري)
              <input name="brand" maxlength="100" placeholder="مثال: ميلانو">
            </label>
          </div>

          <div class="form-grid">
            <label>سعر البيع للجمهور (${currency})
              <input name="price" required inputmode="decimal" placeholder="مثال: 650">
            </label>
            <label>حد التنبيه لنقص المخزون
              <input name="reorderPoint" type="number" required min="0" step="1" value="3">
            </label>
          </div>

          <!-- Section for Model (Colors & Sizes) -->
          <div id="model-variants-panel" class="variant-options-section">
            <label><strong>1. الألوان المتاحة للموديل:</strong></label>
            <div class="color-picker-grid" id="color-chips-picker">
              ${popularColors.map((c) => `<button type="button" class="color-chip-btn ${c === 'أسود' || c === 'أبيض' ? 'active' : ''}" data-color-val="${c}">${c === 'أسود' || c === 'أبيض' ? '✓ ' : ''}${c}</button>`).join('')}
            </div>
            <input class="custom-tags-input" id="extra-color-input" placeholder="+ اكتب لون إضافي واضغط Enter (مثل: هافان غامق...)">

            <label style="margin-top:10px;"><strong>2. المقاسات المتاحة:</strong></label>
            <div class="size-presets-grid" id="size-presets-bar">
              <button type="button" class="size-preset-btn active" data-sizes-preset="men">رجالي (41 إلى 45)</button>
              <button type="button" class="size-preset-btn" data-sizes-preset="women">حريمي (36 إلى 40)</button>
              <button type="button" class="size-preset-btn" data-sizes-preset="kids">أطفال (28 إلى 34)</button>
              <button type="button" class="size-preset-btn" data-sizes-preset="apparel">ملابس (S إلى XXL)</button>
            </div>
            <input class="custom-tags-input" id="sizes-tags-input" value="41, 42, 43, 44, 45" placeholder="المقاسات مفصولة بفاصلة">

            <div class="simple-summary-banner" id="model-summary-box">
              <span id="model-summary-info">تم تجهيز 10 مقاسات وفروع جاهزة للبيع</span>
              <button type="button" class="text-action" id="toggle-advanced-variants" style="font-size:12px;">تخصيص الباركود أو السعر لكل مقاس ⌄</button>
            </div>

            <div id="advanced-matrix-area" hidden>
              <div class="matrix-quick-toolbar">
                <span>تعديل باركود أو سعر فرع معين (اختياري)</span>
                <button type="button" class="date-preset-chip" id="btn-auto-all-barcodes">توليد باركود تلقائي للكل</button>
              </div>
              <div class="variant-matrix-scroll" id="advanced-matrix-table-container"></div>
            </div>
          </div>

          <!-- Section for Single Product -->
          <div id="single-variant-panel" class="form-grid" hidden>
            <label>باركود الصنف (اختياري)
              <input name="singleBarcode" maxlength="64" placeholder="مسح بالباركود أو اتركه فارغاً">
            </label>
          </div>

          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-close-modal>إلغاء</button>
            <button type="submit" class="button button-primary" id="save-product-btn">حفظ المنتج في الكتالوج</button>
          </div>
        </form>
      </section>
    </div>
  `;

  const productForm = modal.querySelector('#product-form');
  modal.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', () => { modal.innerHTML = ''; }));
  modal.querySelector('#add-category-inline')?.addEventListener('click', () => showCategoryModal());

  let currentKind = 'MODEL';
  const selectedColors = new Set(['أسود', 'أبيض']);
  const sizesInput = modal.querySelector('#sizes-tags-input');
  const extraColorInput = modal.querySelector('#extra-color-input');
  const summaryInfo = modal.querySelector('#model-summary-info');
  const modelPanel = modal.querySelector('#model-variants-panel');
  const singlePanel = modal.querySelector('#single-variant-panel');
  const advancedArea = modal.querySelector('#advanced-matrix-area');
  const advancedContainer = modal.querySelector('#advanced-matrix-table-container');
  const customVariantData = new Map();

  const getActiveSizes = () => sizesInput.value.split(/[,،]/).map((s) => s.trim()).filter(Boolean);

  const renderAdvancedTable = () => {
    if (advancedArea.hidden) return;
    const sizes = getActiveSizes();
    const colors = [...selectedColors];
    const baseSku = (productForm.elements.namedItem('sku').value.trim() || 'ITEM').slice(0, 48);
    const defaultPrice = productForm.elements.namedItem('price').value.trim() || '0';
    const defaultReorder = productForm.elements.namedItem('reorderPoint').value.trim() || '3';
    const combinations = [];
    for (const c of colors) {
      for (const s of sizes) {
        combinations.push({ option_1: c, option_2: s });
      }
    }
    const usedSkus = new Set();
    advancedContainer.innerHTML = `
      <table class="variant-matrix-table">
        <thead>
          <tr>
            <th>الفرع (اللون والمقاس)</th>
            <th>كود الفرع (SKU)</th>
            <th>الباركود</th>
            <th>السعر (${currency})</th>
            <th>حد التنبيه</th>
          </tr>
        </thead>
        <tbody>
          ${combinations.map((attr, idx) => {
            const key = `${attr.option_1}:::${attr.option_2}`;
            const saved = customVariantData.get(key) || {};
            const generatedSku = buildSemanticVariantSku(baseSku, attr, idx, usedSkus);
            const sku = saved.sku || generatedSku;
            usedSkus.add(sku.toLowerCase());
            const barcode = saved.barcode || '';
            const price = saved.price || defaultPrice;
            const reorder = saved.reorder || defaultReorder;
            return `
              <tr data-adv-key="${escapeHtml(key)}">
                <td><strong>${escapeHtml(attr.option_1)} · مقاس ${escapeHtml(attr.option_2)}</strong></td>
                <td><input data-adv-sku maxlength="64" value="${escapeHtml(sku)}"></td>
                <td><input data-adv-barcode maxlength="64" value="${escapeHtml(barcode)}" placeholder="تلقائي"></td>
                <td><input data-adv-price inputmode="decimal" value="${escapeHtml(price)}"></td>
                <td><input data-adv-reorder type="number" min="0" step="1" value="${escapeHtml(reorder)}"></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    advancedContainer.querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', () => {
        const tr = input.closest('tr');
        const key = tr.dataset.advKey;
        customVariantData.set(key, {
          sku: tr.querySelector('[data-adv-sku]').value.trim(),
          barcode: tr.querySelector('[data-adv-barcode]').value.trim(),
          price: tr.querySelector('[data-adv-price]').value.trim(),
          reorder: tr.querySelector('[data-adv-reorder]').value.trim(),
        });
      });
    });
  };

  const updateSummary = () => {
    const sizes = getActiveSizes();
    const colorCount = selectedColors.size;
    const sizeCount = sizes.length;
    const totalVariants = colorCount * sizeCount;
    const price = productForm.elements.namedItem('price').value.trim() || '0';
    if (currentKind === 'MODEL') {
      summaryInfo.textContent = totalVariants > 0
        ? `تم تجهيز: ${colorCount} ألوان × ${sizeCount} مقاسات = ${totalVariants} فرع جاهز للبيع بسعر ${price} ${currency}`
        : 'حدد لونًا ومقاسًا واحدًا على الأقل للموديل';
    }
    renderAdvancedTable();
  };

  // Toggle Kind
  modal.querySelectorAll('[data-kind-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('[data-kind-choice]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentKind = btn.dataset.kindChoice;
      if (currentKind === 'MODEL') {
        modelPanel.hidden = false;
        singlePanel.hidden = true;
      } else {
        modelPanel.hidden = true;
        singlePanel.hidden = false;
      }
    });
  });

  // Color chips toggle
  modal.querySelectorAll('[data-color-val]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const color = chip.dataset.colorVal;
      if (selectedColors.has(color)) {
        if (selectedColors.size > 1) selectedColors.delete(color);
        else { toast('حدد لوناً واحداً على الأقل', 'error'); return; }
        chip.classList.remove('active');
        chip.textContent = color;
      } else {
        selectedColors.add(color);
        chip.classList.add('active');
        chip.textContent = `✓ ${color}`;
      }
      updateSummary();
    });
  });

  // Extra color input
  extraColorInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = extraColorInput.value.trim();
      if (val && !selectedColors.has(val)) {
        selectedColors.add(val);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'color-chip-btn active';
        btn.dataset.colorVal = val;
        btn.textContent = `✓ ${val}`;
        btn.addEventListener('click', () => {
          selectedColors.delete(val);
          btn.remove();
          updateSummary();
        });
        modal.querySelector('#color-chips-picker').append(btn);
        extraColorInput.value = '';
        updateSummary();
      }
    }
  });

  // Size Presets
  modal.querySelectorAll('[data-sizes-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('[data-sizes-preset]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const p = btn.dataset.sizesPreset;
      if (p === 'men') sizesInput.value = '41, 42, 43, 44, 45';
      else if (p === 'women') sizesInput.value = '36, 37, 38, 39, 40';
      else if (p === 'kids') sizesInput.value = '28, 30, 32, 34';
      else if (p === 'apparel') sizesInput.value = 'S, M, L, XL, XXL';
      updateSummary();
    });
  });

  sizesInput.addEventListener('input', updateSummary);
  productForm.elements.namedItem('price').addEventListener('input', updateSummary);
  productForm.elements.namedItem('sku').addEventListener('input', updateSummary);

  // Toggle Advanced Matrix
  modal.querySelector('#toggle-custom-matrix, #toggle-advanced-variants')?.addEventListener('click', () => {
    advancedArea.hidden = !advancedArea.hidden;
    renderAdvancedTable();
  });

  // Auto barcodes button
  modal.querySelector('#btn-auto-all-barcodes')?.addEventListener('click', () => {
    const bSet = new Set();
    let idx = 1;
    const baseSku = (productForm.elements.namedItem('sku').value.trim() || 'ITEM').slice(0, 48);
    advancedContainer.querySelectorAll('[data-adv-barcode]').forEach((inp) => {
      const skuVal = inp.closest('tr')?.querySelector('[data-adv-sku]')?.value || baseSku;
      inp.value = generateEan13Barcode(skuVal, idx++, bSet);
      inp.dispatchEvent(new Event('change'));
    });
    toast('تم توليد باركود تلقائي للجميع');
  });

  updateSummary();

  // Submit Handler
  productForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(productForm);
    const submitBtn = modal.querySelector('#save-product-btn');
    submitBtn.disabled = true;

    try {
      const name = String(form.get('name') || '').trim();
      let sku = String(form.get('sku') || '').trim();
      if (!sku) sku = name.slice(0, 6).toUpperCase().replace(/\s+/g, '-');
      const categoryId = form.get('categoryId') || undefined;
      const brand = form.get('brand') || undefined;
      const priceVal = form.get('price');
      const reorderVal = String(form.get('reorderPoint') || '3');

      if (currentKind === 'MODEL') {
        const sizes = getActiveSizes();
        const colors = [...selectedColors];
        if (!colors.length || !sizes.length) throw new Error('يرجى تحديد لون ومقاس واحد على الأقل للموديل');

        const options = [
          { key: 'option_1', name: 'اللون', values: colors },
          { key: 'option_2', name: 'المقاس', values: sizes },
        ];

        const combinations = [];
        for (const c of colors) {
          for (const s of sizes) combinations.push({ option_1: c, option_2: s });
        }

        const usedSkus = new Set();
        const variants = combinations.map((attr, idx) => {
          const key = `${attr.option_1}:::${attr.option_2}`;
          const custom = customVariantData.get(key) || {};
          const generatedSku = buildSemanticVariantSku(sku, attr, idx, usedSkus);
          const varSku = custom.sku || generatedSku;
          usedSkus.add(varSku.toLowerCase());
          return {
            sku: varSku,
            barcode: custom.barcode || undefined,
            attributes: attr,
            retailPrice: toMinor(custom.price || priceVal, currencyDecimals(currency)),
            reorderPoint: custom.reorder || reorderVal,
          };
        });

        await api('/api/products', {
          method: 'POST',
          body: JSON.stringify({
            name, sku, itemKind: 'PRODUCT', categoryId, brand,
            hasVariants: true, options, variants,
          }),
        });
      } else {
        const singleBarcode = String(form.get('singleBarcode') || '').trim() || undefined;
        const variants = [{
          sku: `${sku}-01`,
          barcode: singleBarcode,
          retailPrice: toMinor(priceVal, currencyDecimals(currency)),
          reorderPoint: reorderVal,
        }];

        await api('/api/products', {
          method: 'POST',
          body: JSON.stringify({
            name, sku, itemKind: 'PRODUCT', categoryId, brand,
            hasVariants: false, options: [], variants,
          }),
        });
      }

      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      modal.innerHTML = '';
      state.query = '';
      render();
      toast('تم حفظ المنتج بنجاح في الكتالوج');
    } catch (error) {
      toast(error.message, 'error');
      submitBtn.disabled = false;
    }
  });
}

function bindInventory() {
  bindLocalSearch();
  bindStoreStockActions();
  document.querySelectorAll('.inventory-product-details').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.productId);
    if (product) showInventoryProductDetails(product);
  }));
}

function showInventoryProductDetails(product) {
  const modal = getModalRoot();
  const matrix = extractProductMatrix(product);
  const variants = matrix.activeVariants;
  const total = variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
  const matrixGridHtml = matrix.isMatrix ? `
    <div class="matrix-section-box">
      <div class="matrix-quick-toolbar">
        <span><strong>مصفوفة الألوان × المقاسات للموديل (${escapeHtml(product.sku)})</strong></span>
        <span>إجمالي الرصيد: <strong>${total} قطعة</strong></span>
      </div>
      <div class="table-scroll">
        <table class="variant-matrix-table stock-2d-matrix">
          <thead>
            <tr>
              <th>اللون \\ المقاس</th>
              ${matrix.sizes.map((size) => `<th>مقاس ${escapeHtml(size)}</th>`).join('')}
              <th>إجمالي اللون</th>
            </tr>
          </thead>
          <tbody>
            ${matrix.colors.map((color) => {
              let rowTotal = 0n;
              const cells = matrix.sizes.map((size) => {
                const variant = matrix.matrixMap.get(`${color}:::${size}`);
                if (!variant) return '<td class="matrix-empty-cell">—</td>';
                const qty = BigInt(variant.quantity);
                rowTotal += qty;
                const low = qty <= BigInt(variant.reorderPoint);
                return `<td class="stock-matrix-cell ${qty === 0n ? 'cell-zero' : low ? 'cell-low' : 'cell-ok'}" title="${escapeHtml(variant.sku)}"><strong>${variant.quantity}</strong><small>${escapeHtml(variant.sku)}</small></td>`;
              }).join('');
              return `<tr><td><strong>${escapeHtml(color)}</strong></td>${cells}<td class="table-total"><strong>${rowTotal}</strong></td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '';
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-product-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">تفاصيل الموديل والمقاسات</span><h2 id="inventory-product-title">${escapeHtml(product.name)} (${escapeHtml(product.sku)})</h2><p>إجمالي الرصيد: <strong>${total}</strong> قطعة · ${variants.length} فرع (لون/مقاس)</p></div><button type="button" class="modal-close" data-close-inventory-details aria-label="إغلاق">×</button></div>${matrixGridHtml}${variants.length ? `<details class="compact-disclosure" ${matrix.isMatrix ? '' : 'open'} style="margin: 10px 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden;"><summary style="padding: 12px 16px;"><span>القائمة التفصيلية للفروع والأكواد (SKUs)</span><div style="display:flex;align-items:center;gap:10px;"><span class="status-pill status-complete">${variants.length} فرع</span><span class="disclosure-chevron" style="width:28px;height:28px;" aria-hidden="true">${icon('chevron', 14)}</span></div></summary><div class="disclosure-content"><div class="table-scroll"><table><thead><tr><th>التركيبة</th><th>SKU</th><th>الكمية</th><th>حد التنبيه</th><th>${state.data.capabilities.cashierMode ? 'سعر البيع' : 'متوسط التكلفة'}</th><th>الحالة</th>${state.data.capabilities.canManageCatalog ? '<th>الإجراء</th>' : ''}</tr></thead><tbody>${variants.map((variant) => { const label = formatVariantAttributes(product, variant.attributes, 'النسخة الأساسية'); const low = BigInt(variant.quantity) <= BigInt(variant.reorderPoint); const removeAction = state.data.capabilities.canManageCatalog ? `<td>${BigInt(variant.quantity) === 0n ? `<button type="button" class="text-action product-delete" data-remove-variant="${variant.id}">حذف</button>` : '<small>صفّر الرصيد أولًا للحذف</small>'}</td>` : ''; return `<tr><td><strong>${escapeHtml(label)}</strong></td><td><span class="sku-code">${escapeHtml(variant.sku)}</span></td><td><strong>${variant.quantity}</strong></td><td>${variant.reorderPoint}</td><td>${state.data.capabilities.cashierMode ? ((variant.retailPrice ?? variant.price) ? money(variant.retailPrice ?? variant.price) : '—') : (variant.wac ? money(variant.wac) : '—')}</td><td>${low ? '<span class="status-pill status-low">مخزون منخفض</span>' : '<span class="status-pill status-complete">متوفر</span>'}</td>${removeAction}</tr>`; }).join('')}</tbody></table></div></div></details>` : '<div class="empty-row">لا توجد تركيبات نشطة لهذا المنتج.</div>'}<div class="modal-actions">${state.data.capabilities.canManageCatalog ? `<button type="button" class="button button-secondary" id="inventory-edit-model-btn">توسيع/تعديل الألوان والمقاسات</button>` : ''}<button type="button" class="button button-primary" id="inventory-print-labels-btn">طباعة باركود العلب</button><button type="button" class="button button-secondary" data-close-inventory-details>إغلاق</button></div></section></div>`;
  modal.querySelectorAll('[data-close-inventory-details]').forEach((button) => button.addEventListener('click', () => { modal.innerHTML = ''; }));
  modal.querySelector('#inventory-print-labels-btn')?.addEventListener('click', () => showBarcodeLabelsModal({ product }));
  modal.querySelector('#inventory-edit-model-btn')?.addEventListener('click', () => showProductEditModal(product));
  modal.querySelectorAll('[data-remove-variant]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(button.dataset.removeVariant)}`, { method: 'DELETE' });
      state.report = null;
      state.reportKey = null;
      state.productStats = null;
      state.supplierStats = null;
      state.analyticsKey = null;
      state.salesHistory = null;
      await loadData(state.data.selectedStoreId);
      render();
      toast('تم إخفاء التركيبة من قوائم البيع مع الاحتفاظ بسجلها والفواتير القديمة');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  }));
}

function bindPos() {
  const search = document.querySelector('#pos-search');
  search?.focus();
  search?.addEventListener('input', (event) => { state.query = event.target.value; const cursor = event.target.selectionStart; render(); const next = document.querySelector('#pos-search'); next?.focus(); next?.setSelectionRange(cursor, cursor); });
  search?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const term = event.target.value.trim().toLowerCase();
    const match = state.data.products.flatMap((product) => product.variants.map((variant) => ({ ...variant, productName: product.name, productId: product.id }))).find((variant) => variant.barcode?.toLowerCase() === term || variant.sku.toLowerCase() === term);
    if (match) { addToCart(match.id); }
  });
  document.querySelectorAll('[data-pos-cat]').forEach((chip) => chip.addEventListener('click', () => {
    state.posCategory = chip.dataset.posCat || null;
    render();
  }));
  document.querySelectorAll('[data-pick-product]').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.pickProduct);
    if (!product) return;
    const matrix = extractProductMatrix(product);
    const variants = matrix.activeVariants;
    if (variants.length === 1) { addToCart(variants[0].id); return; }
    const modal = getModalRoot();
    const groupedHtml = matrix.isMatrix ? `<div class="pos-matrix-picker">${matrix.colors.map((color) => `<div class="pos-color-group"><div class="pos-color-title"><span>اللون: <strong>${escapeHtml(color)}</strong></span><small>اختر المقاس لإضافته للفاتورة</small></div><div class="pos-size-grid">${matrix.sizes.map((size) => {
      const variant = matrix.matrixMap.get(`${color}:::${size}`);
      if (!variant) return '';
      const unavailable = product.itemKind === 'PRODUCT' && BigInt(variant.quantity) <= 0n;
      return `<button type="button" class="pos-size-tile ${unavailable ? 'tile-empty' : ''}" data-pos-variant="${variant.id}" ${unavailable ? 'disabled' : ''}><strong>مقاس ${escapeHtml(size)}</strong><span>${money(variant.price)}</span><small>${unavailable ? 'نفد' : `متاح ${variant.quantity}`}</small></button>`;
    }).join('')}</div></div>`).join('')}</div>` : `<div class="form-stack">${variants.map((variant) => { const label = formatVariantAttributes(product, variant.attributes, variant.sku); const unavailable = product.itemKind === 'PRODUCT' && BigInt(variant.quantity) <= 0n; return `<button class="button button-secondary" data-pos-variant="${variant.id}" ${unavailable ? 'disabled' : ''}>${escapeHtml(label)} · ${escapeHtml(variant.sku)} · ${money(variant.price)} · متاح ${variant.quantity}</button>`; }).join('')}</div>`;
    modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">اختيار اللون والمقاس — كود الموديل ${escapeHtml(product.sku)}</span><h2>${escapeHtml(product.name)}</h2></div><button class="modal-close" data-close-modal>×</button></div>${groupedHtml}</section></div>`;
    modal.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { modal.innerHTML = ''; }));
    modal.querySelectorAll('[data-pos-variant]').forEach((choice) => choice.addEventListener('click', () => { const id = choice.dataset.posVariant; modal.innerHTML = ''; addToCart(id); }));
  }));
  document.querySelectorAll('[data-qty]').forEach((button) => button.addEventListener('click', () => changeQuantity(button.dataset.qty, Number(button.dataset.delta))));
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart = state.cart.filter((item) => item.variantId !== button.dataset.remove); render(); }));
  document.querySelector('#clear-cart')?.addEventListener('click', () => { state.cart = []; render(); });
  document.querySelectorAll('[data-method]').forEach((button) => button.addEventListener('click', () => { state.paymentMethod = button.dataset.method; render(); }));
  document.querySelector('#checkout-button')?.addEventListener('click', doCheckout);
  document.querySelector('#pos-start-shift-now-btn')?.addEventListener('click', () => {
    showStartShiftModal();
  });
  document.querySelector('#cart-start-shift-btn')?.addEventListener('click', () => {
    showStartShiftModal();
  });
  document.querySelector('#pos-end-shift-now-btn')?.addEventListener('click', () => {
    showEndShiftModal();
  });
}

function addToCart(variantId) {
  if (state.data?.user?.role !== 'OWNER' && !state.data?.activeShift) {
    toast('يجب بدء الوردية أولاً قبل إجراء أي عملية بيع', 'error');
    showStartShiftModal();
    return;
  }
  const product = state.data.products.find((item) => item.variants.some((variant) => variant.id === variantId));
  const variant = product?.variants.find((item) => item.id === variantId);
  if (!product || !variant) return;
  const stockTracked = product.itemKind !== 'SERVICE';
  if (stockTracked && BigInt(variant.quantity) <= 0n) { toast('الصنف غير متوفر في المخزون', 'error'); return; }
  const existing = state.cart.find((item) => item.variantId === variantId);
  if (existing) {
    if (stockTracked && BigInt(existing.quantity) >= BigInt(variant.quantity)) { toast('الكمية المطلوبة أكبر من الرصيد المتاح', 'error'); return; }
    existing.quantity += 1;
  } else {
    const optionLabel = formatVariantAttributes(product, variant.attributes, '');
    state.cart.push({ variantId, productId: product.id, name: optionLabel ? `${product.name} · ${optionLabel}` : product.name, sku: variant.sku, price: variant.price, quantity: 1, available: variant.quantity, stockTracked });
  }
  state.query = '';
  render();
}

function changeQuantity(variantId, delta) {
  const item = state.cart.find((line) => line.variantId === variantId);
  if (!item) return;
  if (delta > 0 && item.stockTracked && BigInt(item.quantity) >= BigInt(item.available)) { toast('الكمية المطلوبة أكبر من الرصيد المتاح', 'error'); return; }
  item.quantity += delta;
  if (item.quantity < 1) state.cart = state.cart.filter((line) => line.variantId !== variantId);
  render();
}

async function doCheckout() {
  if (state.data?.user?.role !== 'OWNER' && !state.data?.activeShift) {
    toast('يجب بدء الوردية أولاً قبل إجراء أي عملية بيع', 'error');
    showStartShiftModal();
    return;
  }
  if (!state.cart.length || state.isSaving) return;
  const button = document.querySelector('#checkout-button');
  button.disabled = true;
  state.isSaving = true;
  try {
    const totalMinor = state.cart.reduce((sum, item) => sum + BigInt(item.price.amount) * BigInt(item.quantity), 0n).toString();
    const result = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ storeId: state.data.selectedStoreId, idempotencyKey: crypto.randomUUID(), items: state.cart.map((item) => ({ variantId: item.variantId, quantity: String(item.quantity) })), payment: { method: state.paymentMethod, amount: totalMinor } }) });
    state.cart = [];
    state.isSaving = false;
    state.salesHistory = null;
    state.salesHistoryTotal = undefined;
    state.salesHistorySearch = '';
    state.salesFrom = '';
    state.salesTo = '';
    state.report = null;
    state.reportKey = null;
    state.productStats = null;
    state.supplierStats = null;
    state.analyticsKey = null;
    await loadData(state.data.selectedStoreId);
    state.page = 'pos';
    render();
    toast(`تم حفظ الفاتورة ${result.saleNumber} بنجاح`); void showThermalReceiptModal(result.id);
  } catch (error) {
    state.isSaving = false;
    toast(error.message, 'error');
    render();
  }
}

start();
