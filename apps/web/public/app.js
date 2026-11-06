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
  salesTo: null, auditLogs: null, auditChainVerification: null, auditLogsKey: null,
};

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
  { id: 'products', label: 'المنتجات', icon: 'box' },
  { id: 'inventory', label: 'المخزون', icon: 'store' },
  { id: 'sales', label: 'المبيعات', icon: 'chart' },
  { id: 'suppliers', label: 'التجار والمشتريات', icon: 'users' },
  { id: 'expenses', label: 'المصروفات', icon: 'wallet' },
  { id: 'monthly-expenses', label: 'الالتزامات الشهرية', icon: 'chart' },
  { id: 'users', label: '\u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645\u0648\u0646', icon: 'users' },
  { id: 'backups', label: '\u0627\u0644\u0646\u0633\u062e \u0627\u0644\u0627\u062d\u062a\u064a\u0627\u0637\u064a', icon: 'store' },
  { id: 'reports', label: 'الأرباح والخسائر', icon: 'chart' },
  { id: 'top-products', label: 'التقارير', icon: 'chart' },
  { id: 'accounting', label: 'القيود المحاسبية', icon: 'chart' }, { id: 'audit-logs', label: 'سجل المراجعة والأمان', icon: 'scan' },
];

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
  const minor = BigInt(value.amount);
  const decimals = value.decimals;
  const digits = minor < 0n ? (-minor).toString().padStart(decimals + 1, '0') : minor.toString().padStart(decimals + 1, '0');
  const amount = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return `${amount} ${value.currency}`;
}

function toMinor(decimal, decimals) {
  const value = String(decimal).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('اكتب السعر كرقم صحيح');
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`العملة تسمح بحد أقصى ${decimals} خانات عشرية`);
  return `${BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0')}`;
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

async function loadData(storeId) {
  const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
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
    if (state.data.capabilities.cashierMode) state.page = 'pos';
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
  const visibleNavItems = state.data.capabilities.cashierMode ? navItems.filter((item) => item.id === 'pos') : navItems;
  const pageTitle = navItems.find((item) => item.id === state.page)?.label ?? 'الرئيسية';
  return `<aside class="sidebar"><div class="sidebar-brand"><span class="brand-mark">ر</span><span>رَفّ</span></div><div class="workspace-pill"><span class="workspace-dot"></span><span>${escapeHtml(state.data.company.name)}</span><span class="workspace-chevron">⌄</span></div><div class="nav-caption">القائمة الرئيسية</div><nav class="main-nav">${visibleNavItems.filter((item) => item.id !== 'expenses' || state.data.capabilities.canViewExpenses).filter((item) => item.id !== 'accounting' || state.data.capabilities.canViewAccounting).filter((item) => item.id !== 'monthly-expenses' || state.data.capabilities.canViewMonthlyExpenses).filter((item) => item.id !== 'reports' || state.data.capabilities.canViewAccounting).filter((item) => item.id !== 'top-products' || state.data.capabilities.canViewSales).filter((item) => item.id !== 'backups' || state.data.capabilities.canManageBackups).filter((item) => item.id !== 'users' || state.data.capabilities.canManageUsers).filter((item) => item.id !== 'audit-logs' || state.data.capabilities.canViewAuditLogs).filter((item) => item.id !== 'inventory' || state.data.capabilities.canViewInventory).filter((item) => item.id !== 'products' || state.data.capabilities.canManageCatalog).filter((item) => item.id !== 'suppliers' || state.data.capabilities.canManageCatalog).filter((item) => item.id !== 'sales' || state.data.capabilities.canViewSales).map((item) => `<button class="nav-item ${state.page === item.id ? 'active' : ''}" data-page="${item.id}" aria-label="${item.label}" title="${item.label}">${icon(item.icon, 19)}<span>${item.label}</span>${item.id === 'pos' ? '<kbd>F2</kbd>' : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="account-control"><div class="sidebar-user"><div class="avatar">${escapeHtml((state.data.user.fullName ?? state.user.fullName ?? '\u0645').slice(0, 1))}</div><div class="sidebar-user-copy"><strong>${escapeHtml(state.data.user.fullName ?? state.user.fullName ?? '\u0645\u062f\u064a\u0631 \u0627\u0644\u0646\u0638\u0627\u0645')}</strong><small>${roleLabel(state.data.user.role)}</small></div><button type="button" id="account-menu-toggle" class="user-menu" aria-label="\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062d\u0633\u0627\u0628" aria-haspopup="menu" aria-expanded="false" title="\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062d\u0633\u0627\u0628">${icon('more', 19)}</button></div><div id="account-menu" class="account-menu" role="menu" hidden><a class="account-menu-item" role="menuitem" href="mailto:support@retailos.local">${icon('help', 17)}<span>\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u062f\u0639\u0645</span></a><button type="button" id="theme-toggle" class="account-menu-item" role="menuitem">${icon(getTheme() === 'dark' ? 'sun' : 'moon', 17)}<span>${getTheme() === 'dark' ? '\u0627\u0644\u0648\u0636\u0639 \u0627\u0644\u0641\u0627\u062a\u062d' : '\u0627\u0644\u0648\u0636\u0639 \u0627\u0644\u062f\u0627\u0643\u0646'}</span></button><button type="button" id="change-password" class="account-menu-item" role="menuitem">${icon('users', 17)}<span>\u062a\u063a\u064a\u064a\u0631 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631</span></button><button type="button" id="logout-button" class="account-menu-item" role="menuitem">${icon('logout', 17)}<span>\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062e\u0631\u0648\u062c</span></button></div></div></div></aside><main class="main-area"><header class="topbar"><div class="topbar-title"><div class="breadcrumb">مساحة العمل <span>/</span> ${pageTitle}</div><h1>${pageTitle}</h1></div><div class="topbar-actions"><label class="global-search">${icon('search', 18)}<input id="global-search" placeholder="ابحث عن منتج أو فاتورة..." value="${escapeHtml(state.query)}"><kbd>⌘ K</kbd></label><button class="icon-button notification-button" aria-label="التنبيهات">${icon('bell', 19)}${state.data.summary.lowStockCount ? '<i></i>' : ''}</button><span class="topbar-divider"></span><label class="store-select-wrap">${icon('store', 16)}<select id="store-select" ${state.data.user.storeId ? 'disabled' : ''}>${state.data.stores.map((store) => `<option value="${store.id}" ${store.id === state.data.selectedStoreId ? 'selected' : ''}>${escapeHtml(store.name)}</option>`).join('')}</select><span class="select-arrow">⌄</span></label></div></header><section class="page-content">${pageView()}</section><div id="account-modal-root"></div></main>`;
}

function roleLabel(role) {
  return ({ OWNER: 'مدير النظام', STORE_MANAGER: 'مدير فرع', CASHIER: 'كاشير', AUDITOR: 'مراجع' })[role] ?? role;
}

function journalSourceLabel(sourceType) {
  return ({ PURCHASE: 'Purchase', PURCHASE_PAYMENT: 'Supplier payment', SUPPLIER_RETURN: 'Supplier return', SALE: 'Sale', EXPENSE: 'Expense', RETURN: 'Return', TRANSFER: 'Stock transfer', ADJUSTMENT: 'Stock adjustment', SESSION_CLOSING: 'Session closing' })[sourceType] ?? sourceType;
}

function pageView() {
  if (state.data.capabilities.cashierMode) return posView();
  if (state.page === 'pos') return posView();
  if (state.page === 'products') return productsView();
  if (state.page === 'inventory') return inventoryView();
  if (state.page === 'sales') return salesView();
  if (state.page === 'suppliers') return suppliersView();
  if (state.page === 'expenses' && state.data.capabilities.canViewExpenses) return expensesView();
  if (state.page === 'monthly-expenses' && state.data.capabilities.canViewMonthlyExpenses) return monthlyExpensesView();
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
  const allowedRoles = state.data.user.role === 'OWNER' ? ['CASHIER', 'STORE_MANAGER', 'AUDITOR', 'OWNER'] : ['CASHIER'];
  const rows = (state.data.users ?? []).map((user) => {
    const roleOptions = allowedRoles.map((role) => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${userRoleLabel(role)}</option>`).join('');
    const storeOptions = `${state.data.user.role === 'OWNER' ? `<option value="" ${!user.storeId ? 'selected' : ''}>\u0643\u0644 \u0627\u0644\u0641\u0631\u0648\u0639</option>` : ''}${state.data.stores.map((store) => `<option value="${store.id}" ${user.storeId === store.id ? 'selected' : ''}>${escapeHtml(store.name)}</option>`).join('')}`;
    return `<tr><td><button type="button" class="user-detail-button" data-user-details="${user.id}">${escapeHtml(user.fullName)}<small>عرض الملف</small></button></td><td><span class="sku-code">${escapeHtml(user.username)}</span></td><td><span class="status-pill ${user.isActive ? 'status-complete' : 'status-low'}">${user.isActive ? '\u0646\u0634\u0637' : '\u0645\u0648\u0642\u0648\u0641'}</span></td><td><form class="user-update-form" data-user-id="${user.id}"><select name="role" aria-label="\u0635\u0644\u0627\u062d\u064a\u0629 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645">${roleOptions}</select><select name="storeId" aria-label="\u0641\u0631\u0639 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645">${storeOptions}</select><label class="user-active-toggle"><input type="checkbox" name="isActive" ${user.isActive ? 'checked' : ''}>\u0646\u0634\u0637</label><button class="button button-secondary" type="submit">\u062d\u0641\u0638</button></form></td></tr>`;
  }).join('');
  const roleOptions = allowedRoles.map((role) => `<option value="${role}">${userRoleLabel(role)}</option>`).join('');
  const storeOptions = state.data.stores.map((store) => `<option value="${store.id}">${escapeHtml(store.name)}</option>`).join('');
  return `<div class="page-heading-row"><div><p class="page-lead">أنشئ حسابات الموظفين وحدد صلاحياتهم وفروعهم.</p></div></div>
    <section class="panel user-create-panel">
      <div class="user-create-heading"><span class="user-create-icon">${icon('users', 22)}</span><div><span class="eyebrow eyebrow-dark">إدارة الفريق</span><h3>إضافة موظف جديد</h3><p>أنشئ بيانات الدخول وحدد دور الموظف والفرع الذي يعمل فيه.</p></div></div>
      <form id="user-create-form" class="user-create-form">
        <label><span>الاسم الكامل</span><input name="fullName" required minlength="2" maxlength="100" placeholder="مثال: أحمد محمد" autocomplete="name"></label>
        <label><span>رقم الهاتف</span><input name="phone" type="tel" maxlength="32" autocomplete="tel" placeholder="مثال: 01012345678"></label>        <label><span>اسم المستخدم</span><input name="username" required minlength="3" maxlength="30" pattern="[a-z0-9_]+" autocomplete="username" placeholder="ahmed_01"><small>أحرف إنجليزية صغيرة وأرقام وشرطة سفلية فقط.</small></label>
        <label><span>كلمة المرور المؤقتة</span><input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" placeholder="12 حرفًا على الأقل"><small>كلمة قوية، ويمكن للموظف تغييرها من قائمة الحساب.</small></label>
        <label><span>الدور والصلاحية</span><select name="role" required>${roleOptions}</select><small>الكاشير يبيع فقط، والمدير لديه صلاحيات الإدارة.</small></label>
        <label><span>الفرع</span><select name="storeId" id="user-store-select">${state.data.user.role === 'OWNER' ? '<option value="">كل الفروع</option>' : ''}${storeOptions}</select></label>
        <label><span>تاريخ بدء العمل</span><input name="employmentStartDate" type="date" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}" required></label>        <div class="user-create-actions"><span>تأكد من اختيار الفرع المناسب قبل إنشاء الحساب.</span><button class="button button-primary" type="submit">${icon('plus', 17)} إنشاء حساب الموظف</button></div>
      </form>
    </section>
    <section class="panel products-panel"><div class="panel-heading"><div><h3>الموظفون والمستخدمون</h3><p>${(state.data.users ?? []).length} حساب</p></div></div>${rows ? `<div class="table-scroll"><table><thead><tr><th>الاسم</th><th>المستخدم</th><th>الحالة</th><th>الإدارة</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-row">لا يوجد مستخدمون</div>`}</section>`;
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
  const root = document.querySelector('#account-modal-root');
  const storeName = state.data.stores.find((store) => store.id === user.storeId)?.name ?? 'كل الفروع';
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card employee-profile-card" role="dialog" aria-modal="true" aria-labelledby="employee-profile-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">ملف الموظف</span><h2 id="employee-profile-title">${escapeHtml(user.fullName)}</h2></div><button type="button" class="modal-close" data-close-employee aria-label="إغلاق">×</button></div><div class="employee-profile-meta"><div><small>اسم المستخدم</small><strong>${escapeHtml(user.username)}</strong></div><div><small>الدور</small><strong>${userRoleLabel(user.role)}</strong></div><div><small>الفرع</small><strong>${escapeHtml(storeName)}</strong></div><div><small>حالة الحساب</small><strong class="${user.isActive ? 'profile-active' : 'profile-inactive'}">${user.isActive ? 'نشط' : 'موقوف'}</strong></div><div><small>تاريخ إضافة الحساب</small><strong>${employeeDateLabel(user.createdAt, true)}</strong></div><div><small>\u0645\u062f\u0629 \u0627\u0644\u0639\u0645\u0644</small><strong>${employeeTenure(user.employmentStartDate)}</strong></div></div><form id="employee-profile-form" data-user-id="${user.id}" class="employee-profile-form"><label><span>رقم الهاتف</span><input name="phone" type="tel" maxlength="32" autocomplete="tel" value="${escapeHtml(user.phone ?? '')}" placeholder="لم يُسجل رقم هاتف"></label><label><span>تاريخ بدء العمل</span><input name="employmentStartDate" type="date" required value="${escapeHtml(user.employmentStartDate ?? '')}"></label><div class="modal-actions"><button type="button" class="button button-secondary" data-close-employee>إغلاق</button><button type="submit" class="button button-primary">حفظ التفاصيل</button></div></form></section></div>`;
  root.querySelectorAll('[data-close-employee]').forEach((element) => element.addEventListener('click', (event) => {
    if (element === event.target || element.tagName === 'BUTTON') root.innerHTML = '';
  }));
  root.querySelector('#employee-profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    const body = Object.fromEntries(new FormData(form));
    body.phone = body.phone || null;
    button.disabled = true;
    try {
      await api(`/api/users/${form.dataset.userId}`, { method: 'PATCH', body: JSON.stringify(body) });
      await loadData(state.data.selectedStoreId);
      const updatedUser = state.data.users.find((item) => item.id === form.dataset.userId);
      if (updatedUser) showEmployeeDetails(updatedUser);
      toast('تم حفظ بيانات الموظف');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
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
      await loadData(state.data.selectedStoreId);
      render();
      toast('\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
  document.querySelectorAll('[data-user-details]').forEach((button) => button.addEventListener('click', () => {
    const user = (state.data.users ?? []).find((item) => item.id === button.dataset.userDetails);
    if (user) showEmployeeDetails(user);
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
      await loadData(state.data.selectedStoreId);
      render();
      toast('\u062a\u0645 \u062a\u062d\u062f\u064a\u062b \u0635\u0644\u0627\u062d\u064a\u0627\u062a \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  }));
}

function showChangePasswordModal() {
  const root = document.querySelector('#account-modal-root');
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="password-modal-title"><div class="modal-heading"><div><h2 id="password-modal-title">\u062a\u063a\u064a\u064a\u0631 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631</h2></div><button type="button" class="modal-close" data-close-password>?</button></div><form id="account-password-form" class="form-stack"><label>\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062d\u0627\u0644\u064a\u0629<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f<input name="newPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><label>\u062a\u0623\u0643\u064a\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631<input name="confirmPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><div class="modal-actions"><button type="button" class="button button-secondary" data-close-password>\u0625\u0644\u063a\u0627\u0621</button><button type="submit" class="button button-primary">\u062d\u0641\u0638 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631</button></div></form></section></div>`;
  root.querySelectorAll('[data-close-password]').forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  root.querySelector('#account-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
    if (data.newPassword !== data.confirmPassword) { toast('\u0643\u0644\u0645\u062a\u0627 \u0627\u0644\u0645\u0631\u0648\u0631 \u063a\u064a\u0631 \u0645\u062a\u0637\u0627\u0628\u0642\u062a\u064a\u0646', 'error'); return; }
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }) });
      state.user = null; state.data = null; state.cart = []; root.innerHTML = ''; render();
      toast('\u062a\u063a\u064a\u0631\u062a \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631. \u0633\u062c\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0628\u0627\u0644\u0643\u0644\u0645\u0629 \u0627\u0644\u062c\u062f\u064a\u062f\u0629.');
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
  return `<div class="welcome-row"><div><div class="welcome-date">${new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div><h2>${greeting}، ${escapeHtml((data.user.fullName ?? 'مدير النظام').split(' ')[0])} <span>👋</span></h2><p>ده ملخص سريع للي بيحصل في متجرك النهارده.</p></div><button class="button button-primary" data-page="pos">${icon('plus', 18)} عملية بيع جديدة</button></div><div class="metric-grid"><article class="metric-card"><div class="metric-head"><span>مبيعات اليوم</span><span class="metric-icon metric-purple">${icon('wallet', 19)}</span></div><strong>${data.summary.todayRevenue ? money(data.summary.todayRevenue) : '—'}</strong><div class="metric-foot"><span class="metric-muted">${data.summary.todaySalesCount ?? '—'} فاتورة اليوم</span><span class="metric-period">اليوم</span></div></article><article class="metric-card"><div class="metric-head"><span>عدد الفواتير</span><span class="metric-icon metric-green">${icon('bag', 19)}</span></div><strong>${data.summary.todaySalesCount ?? '—'}</strong><div class="metric-foot"><span class="metric-muted">إجمالي العمليات المكتملة</span><span class="metric-positive">اليوم</span></div></article><article class="metric-card"><div class="metric-head"><span>أصناف المنتجات</span><span class="metric-icon metric-blue">${icon('box', 19)}</span></div><strong>${data.summary.productCount}</strong><div class="metric-foot"><span class="metric-muted">منتج مسجل في الكتالوج</span><span class="metric-period">الكتالوج</span></div></article><article class="metric-card"><div class="metric-head"><span>تنبيهات المخزون</span><span class="metric-icon metric-orange">${icon('store', 19)}</span></div><strong>${data.summary.lowStockCount}</strong><div class="metric-foot"><span class="metric-muted">منتجات عند حد إعادة الطلب</span><button class="text-action" data-page="inventory">عرض القائمة ←</button></div></article></div><div class="dashboard-grid"><section class="panel sales-panel"><div class="panel-heading"><div><h3>حركة المبيعات</h3><p>آخر عمليات البيع المسجلة على النظام</p></div><button class="text-action" data-page="sales">كل المبيعات <span>←</span></button></div>${data.sales.length ? `<div class="chart-legend"><span><i></i>قيمة الفاتورة</span><span class="chart-period">آخر الفواتير</span></div><div class="sales-chart">${data.sales.slice(0, 7).reverse().map((sale, index) => `<div class="chart-column"><span class="bar-tooltip">${money(sale.total)}</span><div class="chart-bar ${index === 6 ? 'bar-highlight' : ''}" style="height:${Math.max(12, Number((BigInt(sale.total.amount) * 100n) / maxRevenue))}%"></div><span class="chart-label">${new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' }).format(new Date(sale.createdAt))}</span></div>`).join('')}</div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('chart', 28)}</div><strong>المبيعات هتظهر هنا</strong><p>أول ما تسجل عملية بيع، هتلاقي ملخصها في الصفحة دي.</p><button class="button button-secondary" data-page="pos">ابدأ أول عملية بيع</button></div>`}</section><section class="panel stock-panel"><div class="panel-heading"><div><h3>محتاج إعادة طلب</h3><p>المنتجات اللي عندها تركيبات وصلت لحد الطلب</p></div><button class="icon-button small-icon" data-page="inventory">${icon('arrow', 17)}</button></div>${data.lowStock.length ? `<div class="stock-list">${data.lowStock.slice(0, 5).map((item) => `<div class="stock-row"><div class="stock-thumb">${icon('box', 17)}</div><div class="stock-copy"><strong>${escapeHtml(item.productName)}</strong><small>${item.lowVariantCount} تركيبة تحتاج طلب</small></div><span class="stock-count">${item.quantity} <small>إجمالي</small></span></div>`).join('')}</div>` : `<div class="empty-inline"><span class="empty-check">✓</span><strong>المخزون تمام</strong><p>مفيش أصناف محتاجة إعادة طلب حاليًا.</p></div>`}</section></div><section class="panel recent-panel"><div class="panel-heading"><div><h3>آخر الفواتير</h3><p>متابعة سريعة لأحدث عمليات البيع</p></div><button class="text-action" data-page="sales">عرض الكل <span>←</span></button></div>${sales.length ? salesTable(sales) : `<div class="empty-row">لسه مفيش فواتير. سجّل أول عملية بيع عشان تبدأ تتابع الحركة.</div>`}</section>`;
}

function salesTable(sales) {
  return `<div class="table-scroll"><table><thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>الأصناف</th><th>الدفع</th><th>الإجمالي</th><th>الحالة</th><th></th></tr></thead><tbody>${sales.map((sale) => `<tr><td><button class="invoice-id invoice-open" data-sale-open="${sale.id}">${escapeHtml(sale.saleNumber)}</button></td><td>${new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(sale.createdAt))}</td><td>${sale.items.reduce((sum, item) => sum + Number(item.quantity), 0)} قطعة</td><td><span class="payment-chip">${sale.payments.map((payment) => methodLabel(payment.method)).join(' + ')}</span></td><td class="table-total">${money(sale.total)}</td><td><span class="status-pill status-complete">مكتملة</span></td><td>${state.data.capabilities.canRefund && sale.items.some((item) => BigInt(item.returnableQuantity ?? '0') > 0n) ? `<button class="text-action start-return" data-sale="${sale.id}">مرتجع</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function methodLabel(method) {
  return ({ CASH: 'نقدي', CARD: 'بطاقة', MOBILE: 'محفظة', OTHER: 'أخرى' })[method] ?? method;
}

function productsView() {
  const query = state.query.trim().toLowerCase();
  const products = state.data.products.filter((product) => !query || `${product.name} ${product.sku} ${product.variants.map((item) => `${item.sku} ${item.barcode ?? ''}`).join(' ')}`.toLowerCase().includes(query));
  const rows = products.map((product) => {
    const activeVariants = product.variants.filter((variant) => variant.isActive);
    const totalQuantity = activeVariants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
    const priceRange = activeVariants.length ? (new Set(activeVariants.map((variant) => variant.price.amount)).size === 1 ? money(activeVariants[0].price) : `${money(activeVariants.reduce((min, variant) => BigInt(variant.price.amount) < BigInt(min.price.amount) ? variant : min, activeVariants[0]).price)} – ${money(activeVariants.reduce((max, variant) => BigInt(variant.price.amount) > BigInt(max.price.amount) ? variant : max, activeVariants[0]).price)}`) : '—';
    return `<tr><td><div class="product-table-name"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brand || product.sku)}</small></span></div></td><td><span class="sku-code">${escapeHtml(product.sku)}</span></td><td class="table-total">${priceRange}</td><td><strong>${totalQuantity}</strong> وحدة</td><td>${activeVariants.length} تركيبة</td><td class="product-actions"><button type="button" class="text-action product-edit" data-product-id="${product.id}">التفاصيل والتعديل</button><button type="button" class="text-action product-delete" data-product-id="${product.id}">حذف</button></td></tr>`;
  }).join('');
  return `<div class="page-heading-row"><div><p class="page-lead">كتالوج منتجات ${escapeHtml(state.data.company.name)}</p></div><div class="products-heading-actions"><button class="button button-secondary" id="add-category">${icon('plus', 18)} إضافة فئة</button><button class="button button-primary" id="new-product">${icon('plus', 18)} إضافة منتج</button></div></div><section class="panel products-panel"><div class="panel-heading"><div><h3>قائمة المنتجات</h3><p>${state.data.products.length} منتج أساسي في الكتالوج</p></div><label class="table-search">${icon('search', 17)}<input class="local-search" placeholder="بحث بالاسم أو كود النسخة أو الباركود" value="${escapeHtml(state.query)}"></label></div>${products.length ? `<div class="table-scroll"><table><thead><tr><th>المنتج</th><th>كود المنتج</th><th>سعر البيع</th><th>إجمالي المخزون</th><th>عدد التركيبات</th><th>الإجراءات</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('box', 28)}</div><strong>${query ? 'مفيش نتائج مطابقة' : 'الكتالوج لسه فاضي'}</strong><p>${query ? 'جرب كلمة بحث تانية.' : 'أضف المنتجات اللي بتبيعها، وبعدها استقبل الكمية وسجّل البيع.'}</p>${!query ? '<button class="button button-primary" id="empty-new-product">إضافة أول منتج</button>' : ''}</div>`}</section><div id="modal-root"></div>`;
}

function inventoryView() {
  const data = state.data;
  const items = data.products.filter((product) => product.itemKind === 'PRODUCT').map((product) => {
    const variants = product.variants.filter((variant) => variant.isActive);
    const quantity = variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
    const reorderPoint = variants.reduce((sum, variant) => sum + BigInt(variant.reorderPoint), 0n);
    const hasLowVariant = variants.some((variant) => BigInt(variant.quantity) <= BigInt(variant.reorderPoint));
    const cost = variants.every((variant) => variant.wac) ? (() => {
      const weight = variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
      if (weight <= 0n) return variants[0]?.wac ?? null;
      const amount = variants.reduce((sum, variant) => sum + BigInt(variant.quantity) * BigInt(variant.wac.amount), 0n) / weight;
      return { ...variants[0].wac, amount: amount.toString() };
    })() : null;
    return { ...product, variants, quantity, reorderPoint, hasLowVariant, cost };
  }).filter((product) => product.isActive && (!state.query.trim() || `${product.name} ${product.sku} ${product.variants.map((variant) => `${variant.sku} ${Object.values(variant.attributes ?? {}).join(' ')}`).join(' ')}`.toLowerCase().includes(state.query.trim().toLowerCase())));
  return `<div class="page-heading-row"><div><p class="page-lead">كل منتج أساسي يظهر مرة واحدة بإجمالي رصيده؛ اضغط على اسمه لمراجعة تفاصيل المقاسات والألوان. إضافة البضاعة تتم من فاتورة الشراء.</p></div><div class="products-heading-actions">${data.capabilities.canManageStores ? '<button class="button button-secondary" id="new-store-btn">+ إضافة فرع</button>' : ''}${data.capabilities.canTransferInventory && data.stores.length > 1 ? '<button class="button button-secondary" id="transfer-stock-btn">تحويل مخزون بين الفروع</button>' : ''}<button class="button button-secondary" data-page="suppliers">${icon('plus', 18)} تسجيل فاتورة شراء</button></div></div><div class="inventory-summary"><div class="inventory-summary-card"><span class="summary-badge summary-indigo">${icon('box', 18)}</span><div><small>المنتجات الأساسية</small><strong>${items.length}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-amber">${icon('bell', 18)}</span><div><small>منتجات بها تركيبات منخفضة</small><strong>${data.lowStock.length}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-teal">${icon('store', 18)}</span><div><small>الفرع الحالي</small><strong>${escapeHtml(data.stores.find((store) => store.id === data.selectedStoreId)?.name ?? '—')}</strong></div></div></div><section class="panel"><div class="panel-heading"><div><h3>أرصدة المنتجات</h3><p>الإجمالي هنا للمنتج الأساسي، والتفاصيل داخل المنتج</p></div><label class="table-search">${icon('search', 17)}<input class="local-search" placeholder="ابحث عن المنتج أو كوده" value="${escapeHtml(state.query)}"></label></div>${items.length ? `<div class="table-scroll"><table><thead><tr><th>المنتج</th><th>كود المنتج</th><th>إجمالي الرصيد</th><th>عدد التركيبات</th><th>متوسط التكلفة</th><th>حالة المخزون</th></tr></thead><tbody>${items.map((product) => `<tr><td><button type="button" class="product-name-action inventory-product-details" data-product-id="${product.id}"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><strong>${escapeHtml(product.name)}</strong></button></td><td><span class="sku-code">${escapeHtml(product.sku)}</span></td><td><strong>${product.quantity}</strong> قطعة</td><td>${product.variants.length}</td><td>${product.cost ? money(product.cost) : '—'}</td><td>${product.hasLowVariant ? '<span class="status-pill status-low">تركيبة تحتاج طلب</span>' : '<span class="status-pill status-complete">طبيعي</span>'}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('box', 28)}</div><strong>مفيش منتجات في المخزون</strong><p>سجّل فاتورة شراء لإضافة البضاعة للمخزون.</p><button class="button button-primary" data-page="suppliers">فاتورة شراء</button></div>`}</section><div id="modal-root"></div>`;
}

function salesView() {
  const returns = state.data.customerReturns;
  const sales = state.salesHistory ?? state.data.sales;
  const today = new Date().toISOString().slice(0, 10);
  const from = state.salesFrom ?? today;
  const to = state.salesTo ?? today;
  return `<div class="page-heading-row"><div><p class="page-lead">كل فواتير البيع محفوظة. اختر فترة أو ابحث برقم الفاتورة أو اسم المنتج، وافتح أي فاتورة لعرض تفاصيلها.</p></div><button class="button button-primary" data-page="pos">${icon('plus', 18)} بيع جديد</button></div><section class="panel recent-panel"><form id="sales-history-search" class="sales-filter-bar"><label>من تاريخ<input type="date" name="from" value="${from}" required></label><label>إلى تاريخ<input type="date" name="to" value="${to}" required></label><label class="sales-filter-search">بحث في الفواتير<input name="search" value="${escapeHtml(state.salesHistorySearch)}" placeholder="رقم الفاتورة أو المنتج"></label><button class="button button-primary" type="submit">تطبيق الفلتر</button></form><div class="panel-heading"><div><h3>فواتير البيع</h3><p>${sales.length} من ${state.salesHistoryTotal} فاتورة في الفترة</p></div></div>${sales.length ? `${salesTable(sales)}${sales.length < state.salesHistoryTotal ? '<div class="sales-history-more"><button class="button button-secondary" id="sales-history-more">عرض فواتير أقدم</button></div>' : ''}` : `<div class="empty-chart"><div class="empty-illustration">${icon('chart', 28)}</div><strong>${state.salesHistorySearch ? 'لا توجد فواتير مطابقة' : 'لا توجد مبيعات في الفترة المحددة'}</strong><button class="button button-primary" data-page="pos">ابدأ البيع</button></div>`}</section><details class="panel compact-disclosure"><summary><span>المرتجعات</span><span class="status-pill status-complete">${returns.length} مرتجع</span></summary><div class="disclosure-content">${returns.length ? `<div class="table-scroll"><table><thead><tr><th>رقم المرتجع</th><th>الفاتورة</th><th>التاريخ</th><th>طريقة الرد</th><th>المبلغ</th></tr></thead><tbody>${returns.map((item) => `<tr><td>${escapeHtml(item.returnNumber)}</td><td>${escapeHtml(item.saleNumber)}</td><td>${new Date(item.createdAt).toLocaleString('ar-EG')}</td><td>${methodLabel(item.paymentMethod)}</td><td class="table-total">${money({ amount: item.refundAmount, currency: item.currency, decimals: currencyDecimals(item.currency) })}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد مرتجعات مسجلة.</div>'}</div></details>`;
}

function suppliersView() {
  const suppliers = state.data.suppliers;
  const currency = state.data.company.currency;
  const total = (key) => suppliers.reduce((sum, item) => sum + BigInt(item[key]), 0n).toString();
  const amount = (value) => money({ amount: value, currency, decimals: currencyDecimals(currency) });
  const purchaseDisclosure = (supplier, purchase) => `<details class="purchase-disclosure"><summary><span class="invoice-number">${escapeHtml(purchase.invoiceNumber || `PUR-${purchase.id.slice(0, 8).toUpperCase()}`)}</span><span>${new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(purchase.purchasedAt))}</span><strong>${money(purchase.totalAmount)}</strong><span class="status-pill ${BigInt(purchase.remainingAmount.amount) ? 'status-low' : 'status-complete'}">${BigInt(purchase.remainingAmount.amount) ? `متبقي ${money(purchase.remainingAmount)}` : 'مسددة'}</span></summary><div class="purchase-detail-content"><div class="invoice-detail-meta"><span>التاجر: ${escapeHtml(supplier.name)}</span><span>المدفوع: ${money(purchase.paidAmount)}</span><span>المتبقي: ${money(purchase.remainingAmount)}</span></div><div class="table-scroll"><table><thead><tr><th>المنتج</th><th>كود النسخة</th><th>الكمية</th><th>تكلفة الوحدة</th><th>الإرجاع</th></tr></thead><tbody>${purchase.items.map((item) => `<tr><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.sku)}</td><td>${item.quantity}</td><td>${money(item.unitCost)}</td><td>${BigInt(item.returnableQuantity) > 0n ? `<button class="text-action return-supplier-item" data-purchase="${purchase.id}" data-item="${item.id}" data-quantity="${item.returnableQuantity}">إرجاع ${item.returnableQuantity}</button>` : 'غير متاح'}</td></tr>`).join('')}</tbody></table></div><div class="purchase-detail-actions">${BigInt(purchase.remainingAmount.amount) ? `<button class="button button-secondary pay-purchase" data-purchase="${purchase.id}" data-remaining="${purchase.remainingAmount.amount}">تسجيل سداد</button>` : '<span class="status-pill status-complete">الفاتورة مسددة</span>'}</div>${purchase.payments.length || purchase.returns.length ? `<details class="compact-disclosure"><summary><span>حركات الفاتورة</span><span>${purchase.payments.length} سداد · ${purchase.returns.length} مرتجع</span></summary><div class="disclosure-content">${purchase.payments.map((payment) => `<div class="invoice-history-row">سداد ${money(payment.amount)} · ${methodLabel(payment.paymentMethod)} · ${escapeHtml(payment.referenceNumber || 'بدون مرجع')} · ${new Date(payment.paidAt).toLocaleDateString('ar-EG')}</div>`).join('')}${purchase.returns.map((item) => `<div class="invoice-history-row">مرتجع ${escapeHtml(item.returnNumber)} · ${money(item.creditAmount)} · ${new Date(item.createdAt).toLocaleDateString('ar-EG')}</div>`).join('')}</div></details>` : ''}</div></details>`;
  return `<div class="page-heading-row"><div><p class="page-lead">كل فاتورة ظاهرة برقمها وملخصها. افتحها لعرض الأصناف والسداد والمرتجعات.</p></div><div><button class="button button-secondary" id="new-supplier">إضافة تاجر</button> <button class="button button-primary" id="new-purchase">تسجيل فاتورة شراء</button></div></div><div class="inventory-summary"><div class="inventory-summary-card"><span class="summary-badge summary-indigo">${icon('users', 18)}</span><div><small>التجار المسجلون</small><strong>${suppliers.length}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-teal">${icon('bag', 18)}</span><div><small>إجمالي المشتريات</small><strong>${amount(total('totalPurchased'))}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-amber">${icon('wallet', 18)}</span><div><small>مستحق للتجار</small><strong>${amount(total('balanceDue'))}</strong></div></div></div>${suppliers.length ? suppliers.map((supplier) => `<section class="panel supplier-card"><div class="panel-heading"><div><h3>${escapeHtml(supplier.name)}</h3><p>${escapeHtml(supplier.phone || 'لا يوجد رقم هاتف')} · إجمالي المشتريات ${amount(supplier.totalPurchased)} · المدفوع ${amount(supplier.totalPaid)} · <strong>المتبقي ${amount(supplier.balanceDue)}</strong></p></div><button class="text-action purchase-for-supplier" data-supplier="${supplier.id}">فاتورة جديدة</button></div>${supplier.purchases.length ? `<div class="purchase-list">${supplier.purchases.map((purchase) => purchaseDisclosure(supplier, purchase)).join('')}</div>` : '<div class="empty-row">لا توجد فواتير مسجلة لهذا التاجر.</div>'}</section>`).join('') : `<section class="panel empty-chart"><div class="empty-illustration">${icon('users', 28)}</div><strong>ابدأ بإضافة أول تاجر</strong><p>سجّل فواتير الشراء، المبالغ المدفوعة، والرصيد المتبقي.</p><button class="button button-primary" id="empty-new-supplier">إضافة تاجر</button></section>`}<div id="modal-root"></div>`;
}
function accountingView() {
  const entries = state.data.accountingEntries;
  const currency = state.data.company.currency;
  const format = (value) => money({ amount: value, currency, decimals: currencyDecimals(currency) });
  return `<div class="page-heading-row"><div><p class="page-lead">ملخص مختصر لكل قيد، مع جرد درج النقدية وإدارة الفترات المحاسبية.</p></div><div class="products-heading-actions">${state.data.capabilities.canCloseShift ? '<button class="button button-primary" id="close-shift-btn">تقفيل الوردية وجرد الدرج (Z-Report)</button>' : ''}</div></div>${state.data.drawerBookBalance ? `<div class="inventory-summary"><div class="inventory-summary-card"><span class="summary-badge summary-teal">${icon('wallet', 18)}</span><div><small>رصيد درج النقدية الدفتري (1010)</small><strong>${money(state.data.drawerBookBalance)}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-indigo">${icon('chart', 18)}</span><div><small>القيود المرحلة</small><strong>${entries.length}</strong></div></div></div>` : ''}${(state.data.accountingPeriods ?? []).length ? `<section class="panel"><div class="panel-heading"><div><h3>الفترات المحاسبية</h3><p>إقفال الفترة يمنع إضافة أي قيود بتاريخ قديم داخلها</p></div></div><div class="table-scroll"><table><thead><tr><th>السنة / الفترة</th><th>من</th><th>إلى</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>${state.data.accountingPeriods.map((period) => `<tr><td><strong>${escapeHtml(period.name)}</strong></td><td>${escapeHtml(period.startDate)}</td><td>${escapeHtml(period.endDate)}</td><td><span class="status-pill ${period.status === 'OPEN' ? 'status-complete' : 'status-low'}">${period.status === 'OPEN' ? 'مفتوحة' : 'مقفلة'}</span></td><td>${period.status === 'OPEN' && state.data.capabilities.canClosePeriod ? `<button type="button" class="text-action close-period-btn" data-period-id="${escapeHtml(period.id)}" data-period-name="${escapeHtml(period.name)}">إقفال الفترة</button>` : '—'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}<section class="panel"><div class="panel-heading"><div><h3>القيود المحاسبية</h3><p>${entries.length} قيدًا محملًا</p></div></div>${entries.length ? `<div class="journal-list">${entries.map((entry) => `<details class="compact-disclosure journal-disclosure"><summary><span><strong>${escapeHtml(entry.entryNumber)}</strong><small>${escapeHtml(entry.description)} · ${escapeHtml(entry.date)}</small></span><strong>${format(entry.debitTotal)}</strong><span class="status-pill ${entry.balanced ? 'status-complete' : 'status-low'}">${entry.balanced ? 'متوازن' : 'مراجعة'}</span></summary><div class="disclosure-content"><p class="journal-meta">${journalSourceLabel(entry.sourceType)}</p><div class="table-scroll"><table><thead><tr><th>الحساب</th><th>البيان</th><th>مدين</th><th>دائن</th></tr></thead><tbody>${entry.lines.map((line) => `<tr><td>${escapeHtml(line.accountCode)} · ${escapeHtml(line.accountName)}</td><td>${escapeHtml(line.memo)}</td><td>${line.side === 'DEBIT' ? money(line.amount) : '—'}</td><td>${line.side === 'CREDIT' ? money(line.amount) : '—'}</td></tr>`).join('')}<tr><td colspan="2"><strong>الإجمالي</strong></td><td><strong>${format(entry.debitTotal)}</strong></td><td><strong>${format(entry.creditTotal)}</strong></td></tr></tbody></table></div></div></details>`).join('')}</div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('chart', 28)}</div><strong>لا توجد قيود محاسبية بعد</strong><p>سجّل فاتورة شراء أو سدادًا للتاجر عشان يظهر القيد هنا.</p></div>`}</section><div id="modal-root"></div>`;
}
function profitLossView() {
  const today = new Date().toISOString().slice(0, 10);
  const from = state.reportFrom ?? today, to = state.reportTo ?? today;
  const report = state.report;
  const breakdown = report ? [
    ['إجمالي المبيعات', report.profitLoss.grossSales], ['الخصومات', report.profitLoss.discounts],
    ['مرتجعات العملاء', report.profitLoss.returns], ['صافي المبيعات', report.profitLoss.netSales],
    ['تكلفة البضاعة المباعة', report.profitLoss.cogs], ['مجمل الربح', report.profitLoss.grossProfit],
    ['المصروفات اليومية', report.profitLoss.directExpenses], ['نصيب المصروفات الشهرية', report.profitLoss.monthlyExpenses],
  ] : [];
  return `<div class="page-heading-row"><div><p class="page-lead">ملخص أداء المحل للفترة المحددة. افصل بين الربح التشغيلي وحركة النقدية.</p></div></div><section class="panel"><form id="profit-loss-filter" class="date-filter-bar"><label>من تاريخ<input id="report-from" type="date" value="${from}" required></label><label>إلى تاريخ<input id="report-to" type="date" value="${to}" required></label><button class="button button-primary" type="submit">تحديث الملخص</button></form></section>${report?.missingMonthlyActuals?.length ? `<section class="panel report-notice"><span class="status-pill status-low">تنبيه</span> مصروفات شهرية لم تؤكد: ${report.missingMonthlyActuals.map((item) => `${escapeHtml(item.name)} · ${String(item.month).padStart(2, '0')}/${item.year}`).join('، ')}.</section>` : ''}${report ? `<div class="profit-metrics"><article class="metric-card"><div class="metric-head"><span>صافي المبيعات</span><span class="metric-icon metric-purple">${icon('bag', 19)}</span></div><strong>${money(report.profitLoss.netSales)}</strong><div class="metric-foot"><span>${report.from} — ${report.to}</span></div></article><article class="metric-card"><div class="metric-head"><span>مجمل الربح</span><span class="metric-icon metric-green">${icon('chart', 19)}</span></div><strong>${money(report.profitLoss.grossProfit)}</strong><div class="metric-foot"><span>بعد خصم تكلفة البضاعة</span></div></article><article class="metric-card"><div class="metric-head"><span>المصروفات</span><span class="metric-icon metric-orange">${icon('wallet', 19)}</span></div><strong>${money({ ...report.profitLoss.directExpenses, amount: (BigInt(report.profitLoss.directExpenses.amount) + BigInt(report.profitLoss.monthlyExpenses.amount)).toString() })}</strong><div class="metric-foot"><span>يومية وشهرية</span></div></article><article class="metric-card profit-primary"><div class="metric-head"><span>صافي ربح التشغيل</span><span class="metric-icon metric-green">${icon('chart', 19)}</span></div><strong>${money(report.profitLoss.operatingProfit)}</strong><div class="metric-foot"><span>بعد المصروفات</span></div></article></div><details class="panel compact-disclosure"><summary><span>تفاصيل حساب الأرباح والخسائر</span><span>${report.from} — ${report.to}</span></summary><div class="disclosure-content"><div class="table-scroll"><table><tbody>${breakdown.map(([label, amount]) => `<tr><td>${label}</td><td class="table-total">${money(amount)}</td></tr>`).join('')}<tr><td><strong>صافي ربح التشغيل</strong></td><td class="table-total"><strong>${money(report.profitLoss.operatingProfit)}</strong></td></tr></tbody></table></div></div></details><details class="panel compact-disclosure"><summary><span>تفاصيل التدفق النقدي</span><span>التحصيل والمدفوعات خلال الفترة</span></summary><div class="disclosure-content"><div class="report-cash-list"><div><span>مبيعات نقدية</span><strong>${money(report.cashFlow.cashSales)}</strong></div><div><span>مبيعات إلكترونية</span><strong>${money(report.cashFlow.electronicSales)}</strong></div><div><span>مصروفات مدفوعة</span><strong>${money(report.cashFlow.directExpenseOutflow)}</strong></div><div><span>سداد الالتزامات</span><strong>${money(report.cashFlow.monthlyObligationOutflow)}</strong></div><div><span>مستحقات غير مسددة بنهاية الفترة</span><strong>${money(report.cashFlow.pendingUnpaidObligations)}</strong></div></div></div></details>` : '<section class="panel empty-row">جاري تحميل التقرير...</section>'}<div id="modal-root"></div>`;
}
function topProductsView() {
  const stats = state.productStats;
  const vendors = state.supplierStats;
  const today = new Date().toISOString().slice(0, 10);
  const from = state.analyticsFrom ?? (() => { const date = new Date(); date.setUTCDate(date.getUTCDate() - 29); return date.toISOString().slice(0, 10); })();
  const to = state.analyticsTo ?? today;
  const products = stats?.products ?? [];
  const maxUnits = products.reduce((max, product) => BigInt(product.unitsSold) > max ? BigInt(product.unitsSold) : max, 1n);
  return `<div class="page-heading-row"><div><p class="page-lead">تقارير المبيعات والمشتريات حسب الفترة التي تختارها.</p></div></div><section class="panel"><form id="analytics-filter" class="date-filter-bar"><label>من تاريخ<input name="from" type="date" value="${from}" required></label><label>إلى تاريخ<input name="to" type="date" value="${to}" required></label><button class="button button-primary" type="submit">عرض التقارير</button></form></section>${!stats || !vendors ? '<section class="panel"><div class="empty-row">جاري تحميل التقارير...</div></section>' : `<div class="metric-grid product-stat-metrics"><article class="metric-card"><div class="metric-head"><span>الأكثر مبيعًا بالكمية</span><span class="metric-icon metric-purple">${icon('box', 19)}</span></div><strong>${stats.topByUnits ? escapeHtml(stats.topByUnits.name) : '—'}</strong><div class="metric-foot"><span class="metric-muted">${stats.topByUnits ? `${stats.topByUnits.unitsSold} قطعة صافي` : 'لا توجد مبيعات في الفترة'}</span></div></article><article class="metric-card"><div class="metric-head"><span>أعلى منتج في الإيراد</span><span class="metric-icon metric-green">${icon('chart', 19)}</span></div><strong>${stats.topByRevenue ? money(stats.topByRevenue.netRevenue) : '—'}</strong><div class="metric-foot"><span class="metric-muted">${stats.topByRevenue ? escapeHtml(stats.topByRevenue.name) : 'لا توجد مبيعات في الفترة'}</span></div></article>${state.data.capabilities.canViewAccounting ? `<article class="metric-card"><div class="metric-head"><span>أكثر تاجر شراءً</span><span class="metric-icon metric-purple">${icon('users', 19)}</span></div><strong>${vendors.topBySpend ? escapeHtml(vendors.topBySpend.name) : '—'}</strong><div class="metric-foot"><span class="metric-muted">${vendors.topBySpend ? money(vendors.topBySpend.totalAmount) : 'لا توجد مشتريات في الفترة'}</span></div></article><article class="metric-card"><div class="metric-head"><span>أكثر تاجر فواتير</span><span class="metric-icon metric-green">${icon('bag', 19)}</span></div><strong>${vendors.topByInvoices ? escapeHtml(vendors.topByInvoices.name) : '—'}</strong><div class="metric-foot"><span class="metric-muted">${vendors.topByInvoices ? `${vendors.topByInvoices.invoiceCount} فاتورة` : 'لا توجد مشتريات في الفترة'}</span></div></article>` : ''}</div><details class="panel compact-disclosure" open><summary><span>المنتجات الأكثر مبيعًا</span><span>${products.length} منتجات</span></summary><div class="disclosure-content">${products.length ? `<div class="table-scroll"><table><thead><tr><th>الترتيب</th><th>المنتج</th><th>القطع المباعة</th><th>الفواتير</th><th>صافي الإيراد</th></tr></thead><tbody>${products.map((product, index) => `<tr><td><span class="product-rank ${index === 0 ? 'product-rank-first' : ''}">${index + 1}</span></td><td><strong>${escapeHtml(product.name)}</strong></td><td><div class="product-units-cell"><strong>${product.unitsSold}</strong><span class="product-units-track"><i style="width:${Math.max(4, Number(BigInt(product.unitsSold) * 100n / maxUnits))}%"></i></span></div></td><td>${product.orderCount}</td><td class="table-total">${money(product.netRevenue)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد مبيعات في الفترة المحددة.</div>'}</div></details>${state.data.capabilities.canViewAccounting ? `<details class="panel compact-disclosure"><summary><span>المشتريات حسب التاجر</span><span>${vendors.suppliers.length} تجار</span></summary><div class="disclosure-content">${vendors.suppliers.length ? `<div class="table-scroll"><table><thead><tr><th>الترتيب</th><th>التاجر</th><th>عدد الفواتير</th><th>إجمالي الشراء</th></tr></thead><tbody>${vendors.suppliers.map((supplier, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(supplier.name)}</strong></td><td>${supplier.invoiceCount}</td><td class="table-total">${money(supplier.totalAmount)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد مشتريات في الفترة المحددة.</div>'}</div></details>` : ''}<button class="button button-secondary" data-page="reports">عرض الأرباح والخسائر</button>`}`;
}
function expensesView() {
  const expenses = state.data.expenses;
  const currency = state.data.company.currency;
  const total = expenses.reduce((sum, expense) => sum + BigInt(expense.amount.amount), 0n).toString();
  const categoryTotal = new Map();
  for (const expense of expenses) categoryTotal.set(expense.category, (categoryTotal.get(expense.category) ?? 0n) + BigInt(expense.amount.amount));
  const sortedCategories = [...categoryTotal].sort((a, b) => a[1] > b[1] ? -1 : 1);
  return `<div class="page-heading-row"><div><p class="page-lead">ملخص المصروفات المسجلة، مع تفاصيل كل حركة عند فتحها.</p></div>${state.data.capabilities.canCreateExpenses ? '<button class="button button-primary" id="new-expense">تسجيل مصروف</button>' : ''}</div><div class="inventory-summary"><div class="inventory-summary-card"><span class="summary-badge summary-amber">${icon('wallet', 18)}</span><div><small>إجمالي المصروفات المحملة</small><strong>${money({ amount: total, currency, decimals: currencyDecimals(currency) })}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-indigo">${icon('chart', 18)}</span><div><small>عدد الحركات</small><strong>${expenses.length}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-teal">${icon('box', 18)}</span><div><small>أعلى بند</small><strong>${sortedCategories.length ? escapeHtml(sortedCategories[0][0]) : '—'}</strong></div></div></div><section class="panel"><div class="panel-heading"><div><h3>سجل المصروفات</h3><p>آخر ${expenses.length} حركة من أصل السجل المتاح</p></div></div>${expenses.length ? `<div class="expense-list">${expenses.map((expense) => `<details class="compact-disclosure expense-disclosure"><summary><span><strong>${escapeHtml(expense.category)}</strong><small>${escapeHtml(expense.date)}</small></span><strong>${money(expense.amount)}</strong><span class="details-hint">التفاصيل</span></summary><div class="disclosure-content"><div class="invoice-detail-meta"><span>طريقة الدفع: ${expense.paymentMethod === 'CASH_DRAWER' ? 'درج النقدية' : expense.paymentMethod === 'CASH_SAFE' ? 'الخزينة' : 'تحويل بنكي'}</span><span>الملاحظات: ${escapeHtml(expense.notes || '—')}</span><span>المرجع: ${escapeHtml(expense.referenceNumber || '—')}</span></div></div></details>`).join('')}</div>` : `<div class="empty-chart"><div class="empty-illustration">${icon('wallet', 28)}</div><strong>لا توجد مصروفات مسجلة</strong><p>أضف الإيجار أو المرافق أو مصروفات التشغيل اليومية.</p></div>`}</section><div id="modal-root"></div>`;
}
function monthlyExpensesView() {
  const items = state.data.monthlyExpenses;
  const period = state.data.monthlyPeriod;
  const currency = state.data.company.currency;
  const format = (value) => money({ amount: value, currency, decimals: currencyDecimals(currency) });
  const confirmed = items.filter((item) => item.actual);
  const due = confirmed.reduce((sum, item) => sum + BigInt(item.actual.remainingAmount.amount), 0n).toString();
  const accrued = confirmed.reduce((sum, item) => sum + BigInt(item.actual.amount.amount), 0n).toString();
  return `<div class="page-heading-row"><div><p class="page-lead">التزامات شهر ${String(period.month).padStart(2, '0')} / ${period.year}: أثبت المصروف أولًا، وبعدها سجّل السداد من المستحق.</p></div>${state.data.capabilities.canConfirmMonthlyExpenses ? '<button class="button button-primary" id="new-monthly-obligation">إضافة التزام شهري</button>' : ''}</div><div class="inventory-summary"><div class="inventory-summary-card"><span class="summary-badge summary-indigo">${icon('chart', 18)}</span><div><small>المصروفات المثبتة للشهر</small><strong>${format(accrued)}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-amber">${icon('wallet', 18)}</span><div><small>مستحق غير مسدد</small><strong>${format(due)}</strong></div></div><div class="inventory-summary-card"><span class="summary-badge summary-teal">${icon('bell', 18)}</span><div><small>التزامات مسجلة</small><strong>${items.length}</strong></div></div></div>${items.length ? items.map((item) => `<section class="panel supplier-card"><div class="panel-heading"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)} · موعد الاستحقاق يوم ${item.dueDay}</p></div>${item.actual ? `<span class="status-pill ${item.actual.status === 'PAID' ? 'status-complete' : 'status-low'}">${item.actual.status === 'PAID' ? 'مسدد بالكامل' : item.actual.status === 'PARTIALLY_PAID' ? 'مدفوع جزئيًا' : 'مستحق'}</span>` : '<span class="status-pill status-low">لم يتم تأكيد قيمة هذا الشهر</span>'}</div>${item.actual ? `<div class="inventory-summary"><div class="inventory-summary-card"><small>المبلغ المثبت</small><strong>${money(item.actual.amount)}</strong></div><div class="inventory-summary-card"><small>المدفوع</small><strong>${money(item.actual.paidAmount)}</strong></div><div class="inventory-summary-card"><small>المتبقي</small><strong>${money(item.actual.remainingAmount)}</strong></div></div>${state.data.capabilities.canPayMonthlyExpenses && BigInt(item.actual.remainingAmount.amount) > 0n ? `<button class="button button-secondary pay-monthly" data-actual="${item.actual.id}" data-remaining="${item.actual.remainingAmount.amount}">تسجيل سداد</button>` : ''}${item.actual.payments.map((payment) => `<div class="empty-row">سداد ${money(payment.amount)} · ${payment.method === 'CASH_DRAWER' ? 'درج النقدية' : payment.method === 'CASH_SAFE' ? 'الخزينة' : 'تحويل بنكي'} · ${escapeHtml(payment.referenceNumber || 'بدون مرجع')} · ${escapeHtml(payment.paidAt)}</div>`).join('')}` : `${state.data.capabilities.canConfirmMonthlyExpenses ? `<button class="button button-primary confirm-monthly" data-obligation="${item.id}">تأكيد المبلغ الفعلي للشهر</button>` : ''}`}</section>`).join('') : `<section class="panel empty-chart"><div class="empty-illustration">${icon('chart', 28)}</div><strong>لا توجد التزامات شهرية</strong><p>أضف الإيجار أو أي التزام ثابت، ثم أكد قيمته الفعلية في بداية كل شهر.</p></section>`}<div id="modal-root"></div>`;
}

function posView() {
  const query = state.query.trim().toLowerCase();
  const products = state.data.products.filter((product) => product.isActive).map((product) => ({ ...product, variants: product.variants.filter((variant) => variant.isActive) })).filter((product) => product.variants.length && (!query || `${product.name} ${product.sku} ${product.variants.map((variant) => `${variant.sku} ${variant.barcode ?? ''} ${Object.values(variant.attributes ?? {}).join(' ')}`).join(' ')}`.toLowerCase().includes(query)));
  const totalMinor = state.cart.reduce((sum, item) => sum + BigInt(item.price.amount) * BigInt(item.quantity), 0n);
  const currency = state.data.company.currency;
  const decimals = state.cart[0]?.price.decimals ?? currencyDecimals(currency);
  const total = { amount: totalMinor.toString(), currency, decimals };
  return `<div class="pos-layout"><section class="pos-catalog"><div class="pos-page-title"><div><span class="eyebrow eyebrow-dark">نقطة البيع</span><h2>عملية بيع جديدة</h2><p>ابحث عن المنتج ثم اختر التركيبة المطلوبة.</p></div><div class="pos-shortcut">${icon('scan', 18)}<span>نقطة بيع الفرع</span><kbd>F2</kbd></div></div><label class="pos-search">${icon('search', 20)}<input id="pos-search" placeholder="ابحث بالاسم أو SKU أو الباركود" value="${escapeHtml(state.query)}" autofocus><kbd>Enter</kbd></label><div class="pos-category-row"><button class="category-chip active">كل المنتجات <span>${products.length}</span></button>${state.data.categories.slice(0, 5).map((category) => `<button class="category-chip">${escapeHtml(category.name)}</button>`).join('')}</div><div class="pos-products">${products.map((product, index) => { const stock = product.variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n); const allSamePrice = new Set(product.variants.map((variant) => variant.price.amount)).size === 1; const price = allSamePrice ? money(product.variants[0].price) : 'أسعار متعددة'; const label = `${product.name} · ${product.variants.length} تركيبة`; return `<button class="pos-product-card" data-pick-product="${product.id}" ${product.itemKind === 'PRODUCT' && stock <= 0n ? 'disabled' : ''}><span class="pos-product-art art-${index % 6}">${icon('box', 27)}</span><span class="pos-product-info"><strong>${escapeHtml(label)}</strong><small>${product.itemKind === 'SERVICE' ? 'خدمة' : `${stock} متاح`}</small><b>${price}</b></span><span class="add-product-mark">${icon('plus', 16)}</span></button>`; }).join('') || `<div class="pos-no-products"><div class="empty-illustration">${icon('search', 27)}</div><strong>${state.data.products.length ? 'مفيش منتج مطابق للبحث' : 'أضف منتجاتك الأول'}</strong><button class="text-action" data-page="products">الذهاب للمنتجات ←</button></div>`}</div></section><aside class="cart-panel"><div class="cart-header"><div><span class="eyebrow eyebrow-dark">الفاتورة الحالية</span><h3>فاتورة جديدة</h3></div><button id="clear-cart" class="text-action" ${state.cart.length ? '' : 'disabled'}>مسح الكل</button></div><div class="cart-store-name">${icon('store', 16)} ${escapeHtml(state.data.stores.find((store) => store.id === state.data.selectedStoreId)?.name ?? '')}<span class="live-dot"></span></div><div class="cart-items" id="cart-items">${state.cart.length ? state.cart.map((item) => `<div class="cart-line"><div class="cart-line-main"><span class="cart-line-art">${icon('box', 16)}</span><div><strong>${escapeHtml(item.name)}</strong><small>${money(item.price)} × ${item.quantity}</small></div><button class="remove-line" data-remove="${item.variantId}" aria-label="حذف">×</button></div><div class="cart-line-bottom"><div class="quantity-control"><button data-qty="${item.variantId}" data-delta="-1">−</button><span>${item.quantity}</span><button data-qty="${item.variantId}" data-delta="1">+</button></div><strong>${money({ ...item.price, amount: (BigInt(item.price.amount) * BigInt(item.quantity)).toString() })}</strong></div></div>`).join('') : `<div class="cart-empty"><span class="cart-empty-icon">${icon('bag', 23)}</span><strong>الفاتورة لسه فاضية</strong><p>اختار منتج من القائمة أو امسح الباركود عشان تضيفه.</p></div>`}</div><div class="cart-footer"><div class="cart-totals"><div><span>عدد القطع</span><strong>${state.cart.reduce((sum, item) => sum + item.quantity, 0)}</strong></div><div><span>الخصم</span><strong>${money({ ...total, amount: '0' })}</strong></div><div class="cart-grand-total"><span>الإجمالي المستحق</span><strong>${money(total)}</strong></div></div><div class="payment-heading"><span>طريقة الدفع</span></div><div class="payment-methods">${[['CASH', 'نقدي', '◉'], ['CARD', 'بطاقة', '▤'], ['MOBILE', 'محفظة', '▦']].map(([method, label, mark]) => `<button class="payment-method ${state.paymentMethod === method ? 'selected' : ''}" data-method="${method}"><span>${mark}</span>${label}</button>`).join('')}</div><button id="checkout-button" class="button button-primary checkout-button" ${state.cart.length && !state.isSaving ? '' : 'disabled'}><span>إتمام البيع</span><strong>${money(total)}</strong></button><p class="secure-checkout">${icon('wallet', 14)} العملية هتتحفظ مباشرة في قاعدة بيانات المتجر</p></div><div id="modal-root"></div></div>`;
}

function supplierModal(html, formId, endpoint, convert = (data) => data, successMessage = 'تم حفظ الحركة في سجل التاجر') {
  const root = document.querySelector('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><div class="modal-heading"><h2>${formId === 'supplier-form' ? 'إضافة تاجر' : formId === 'purchase-form' ? 'تسجيل فاتورة شراء' : formId === 'expense-form' ? 'تسجيل مصروف' : formId === 'return-form' ? 'تسجيل مرتجع مرتبط بالفاتورة' : formId === 'supplier-return-form' ? '\u062a\u0633\u062c\u064a\u0644 \u0645\u0631\u062a\u062c\u0639 \u0644\u0644\u0645\u0648\u0631\u062f' : formId === 'monthly-obligation-form' ? 'إضافة التزام شهري' : formId === 'monthly-actual-form' ? 'تأكيد المصروف الفعلي' : 'تسجيل سداد'}</h2><button class="modal-close" data-close-modal>×</button></div><form id="${formId}" class="form-stack modal-form">${html}<div class="modal-actions"><button type="button" class="button button-secondary" data-close-modal>إلغاء</button><button type="submit" class="button button-primary">حفظ</button></div></form></section></div>`;
  root.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  root.querySelector(`#${formId}`).addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true;
    try {
      const data = convert(Object.fromEntries(new FormData(event.currentTarget)));
      await api(endpoint, { method: 'POST', body: JSON.stringify(data) });
      await loadData(state.data.selectedStoreId); render(); toast(successMessage);
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
}

function bindExpenses() {
  document.querySelector('#new-expense')?.addEventListener('click', () => {
    const decimals = currencyDecimals(state.data.company.currency);
    const date = new Date().toISOString().slice(0, 10);
    supplierModal(`<label>تصنيف المصروف<select name="categoryCode"><option value="RENT">إيجار المحل</option><option value="UTILITIES">مرافق وفواتير</option><option value="TRANSPORT">نقل ومواصلات</option><option value="MAINTENANCE">صيانة</option><option value="SUPPLIES">مستلزمات تشغيل</option><option value="OTHER">مصروفات أخرى</option></select></label><div class="form-grid"><label>المبلغ (${state.data.company.currency})<input name="amount" inputmode="decimal" required></label><label>تاريخ المصروف<input name="expenseDate" type="date" value="${date}" required></label></div><label>طريقة الدفع<select name="paymentMethod"><option value="CASH_DRAWER">درج النقدية</option><option value="CASH_SAFE">الخزينة</option><option value="BANK_TRANSFER">تحويل بنكي</option></select></label><label>ملاحظات<input name="notes" maxlength="500"></label><label>رقم مرجعي<input name="referenceNumber" maxlength="80"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'expense-form', '/api/expenses', (data) => ({ ...data, amount: toMinor(data.amount, decimals) }), 'تم تسجيل المصروف والقيد المحاسبي');
  });
}

function bindSuppliers() {
  document.querySelector('#new-supplier, #empty-new-supplier')?.addEventListener('click', () => supplierModal('<label>اسم التاجر<input name="name" required minlength="2" maxlength="120"></label><label>رقم الهاتف<input name="phone" maxlength="40" type="tel"></label><label>ملاحظات<input name="notes" maxlength="500"></label>', 'supplier-form', '/api/suppliers'));
  const purchase = (supplierId = '') => {
    if (!state.data.suppliers.length) { toast('أضف التاجر الأول قبل تسجيل الفاتورة', 'error'); return; }
    const products = state.data.products.filter((product) => product.itemKind === 'PRODUCT' && product.isActive && product.variants.some((variant) => variant.isActive));
    if (!products.length) { toast('أضف المنتجات قبل تسجيل فاتورة شراء', 'error'); return; }
    let groupIndex = 0;
    const selections = new Map();
    const groupMarkup = (index) => `<section class="purchase-product-group" data-purchase-group="${index}"><div class="form-grid"><label>المنتج الأساسي<select name="purchaseProduct_${index}">${products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join('')}</select></label><label>تكلفة الوحدة (${state.data.company.currency})<input name="purchaseCost_${index}" inputmode="decimal" required></label><button type="button" class="text-action remove-purchase-group">إزالة المنتج</button></div><div class="purchase-variant-grid"></div></section>`;
    supplierModal(`<label>التاجر<select name="supplierId">${state.data.suppliers.map((supplier) => `<option value="${supplier.id}" ${supplier.id === supplierId ? 'selected' : ''}>${escapeHtml(supplier.name)}</option>`).join('')}</select></label><label>رقم فاتورة التاجر (اختياري)<input name="invoiceNumber" maxlength="80" placeholder="يُنشأ رقم تلقائي إذا تُرك فارغًا"></label><div id="purchase-lines">${groupMarkup(groupIndex)}</div><button id="add-purchase-product" type="button" class="button button-secondary">إضافة منتج للفاتورة</button><p class="variant-options-note">اختار المنتج الأساسي واكتب كمية كل مقاس أو لون في الجدول. تكلفة الوحدة تُطبق على تركيبات المنتج المحدد.</p><div class="form-grid"><label>إجمالي الفاتورة (${state.data.company.currency}) — محسوب من الأصناف<input name="totalAmount" inputmode="decimal" required readonly></label><label>المدفوع الآن<input name="paidAmount" inputmode="decimal" value="0" required></label></div><label>طريقة السداد الأولي<select name="paymentMethod"><option value="CASH">نقدي</option><option value="BANK_TRANSFER">تحويل بنكي</option><option value="CARD">بطاقة</option><option value="MOBILE">محفظة</option></select></label><label>مرجع السداد<input name="referenceNumber" maxlength="80"></label><label>ملاحظات<input name="notes" maxlength="500"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'purchase-form', '/api/purchases', (data) => {
      const items = [];
      for (const [key, quantity] of Object.entries(data)) {
        if (!key.startsWith('purchaseQty_') || Number(quantity) <= 0) continue;
        const match = key.match(/^purchaseQty_(\d+)_([0-9a-f-]+)$/i);
        if (!match) continue;
        const [, index, variantId] = match;
        items.push({ variantId, quantity, unitCost: toMinor(data[`purchaseCost_${index}`], currencyDecimals(state.data.company.currency)) });
      }
      if (!items.length) throw new Error('حدد كمية لتركيبة واحدة على الأقل في الفاتورة');
      return { ...data, items, totalAmount: toMinor(data.totalAmount, currencyDecimals(state.data.company.currency)), paidAmount: toMinor(data.paidAmount, currencyDecimals(state.data.company.currency)) };
    });
    const root = document.querySelector('#modal-root');
    const form = root.querySelector('#purchase-form');
    const updatePurchaseTotal = () => {
      let totalMinor = 0n;
      for (const [index, selection] of selections) {
        if (!selection.size) continue;
        const unitCost = form.elements.namedItem(`purchaseCost_${index}`).value;
        if (!unitCost) continue;
        const minor = BigInt(toMinor(unitCost, currencyDecimals(state.data.company.currency)));
        for (const quantity of selection.values()) totalMinor += minor * BigInt(quantity);
      }
      form.elements.namedItem('totalAmount').value = decimalPrice({ amount: totalMinor.toString(), decimals: currencyDecimals(state.data.company.currency) });
    };
    const renderGroup = (section) => {
      const index = section.dataset.purchaseGroup;
      const product = products.find((item) => item.id === section.querySelector(`[name="purchaseProduct_${index}"]`).value);
      const groupSelection = selections.get(index) ?? new Map();
      selections.set(index, groupSelection);
      section.querySelector(`[name="purchaseCost_${index}"]`).required = groupSelection.size > 0;
      const variants = product.variants.filter((variant) => variant.isActive);
      section.querySelector('.purchase-variant-grid').innerHTML = `<div class="table-scroll"><table class="variant-matrix-table purchase-variant-table"><thead><tr><th>اللون والمقاس</th><th>SKU</th><th>الرصيد الحالي</th><th>الكمية في الفاتورة</th></tr></thead><tbody>${variants.map((variant) => {
        const quantity = groupSelection.get(variant.id) ?? 0;
        const label = Object.entries(variant.attributes ?? {}).map(([key, value]) => `${product.options?.find((option) => option.key === key)?.name ?? key}: ${value}`).join(' · ') || 'النسخة الأساسية';
        return `<tr class="${quantity ? 'selected' : ''}"><td><strong>${escapeHtml(label)}</strong></td><td><span class="sku-code">${escapeHtml(variant.sku)}</span></td><td>${variant.quantity}</td><td><input type="number" min="0" step="1" data-purchase-quantity="${variant.id}" name="purchaseQty_${index}_${variant.id}" value="${quantity}" aria-label="كمية ${escapeHtml(label)}"></td></tr>`;
      }).join('')}</tbody></table></div>`;
    };
    renderGroup(root.querySelector('[data-purchase-group]'));
    updatePurchaseTotal();
    root.querySelector('#purchase-lines')?.addEventListener('input', (event) => {
      if (event.target.matches('[name^="purchaseCost_"]')) updatePurchaseTotal();
      const quantityInput = event.target.closest('[data-purchase-quantity]');
      if (quantityInput) {
        const section = quantityInput.closest('[data-purchase-group]');
        const index = section.dataset.purchaseGroup;
        const variantId = quantityInput.dataset.purchaseQuantity;
        const quantity = Math.max(0, Math.floor(Number(quantityInput.value) || 0));
        const groupSelection = selections.get(index) ?? new Map();
        if (quantity) groupSelection.set(variantId, quantity); else groupSelection.delete(variantId);
        selections.set(index, groupSelection);
        quantityInput.closest('tr').classList.toggle('selected', quantity > 0);
        updatePurchaseTotal();
      }
    });
    root.querySelector('#add-purchase-product')?.addEventListener('click', () => {
      const index = ++groupIndex;
      root.querySelector('#purchase-lines').insertAdjacentHTML('beforeend', groupMarkup(index));
      renderGroup(root.querySelector(`[data-purchase-group="${index}"]`));
      updatePurchaseTotal();
    });
    root.querySelector('#purchase-lines')?.addEventListener('change', (event) => {
      if (event.target.matches('[name^="purchaseProduct_"]')) { selections.set(event.target.name.replace('purchaseProduct_', ''), new Map()); renderGroup(event.target.closest('[data-purchase-group]')); updatePurchaseTotal(); }
      if (event.target.matches('[data-purchase-quantity]')) event.target.value = String(Math.max(0, Math.floor(Number(event.target.value) || 0)));
    });
    root.querySelector('#purchase-lines')?.addEventListener('click', (event) => {
      const section = event.target.closest('[data-purchase-group]');
      if (!section) return;
      const index = section.dataset.purchaseGroup;
      if (event.target.closest('.remove-purchase-group')) { if (root.querySelectorAll('[data-purchase-group]').length > 1) { selections.delete(index); section.remove(); updatePurchaseTotal(); } return; }
    });
  };
  document.querySelector('#new-purchase')?.addEventListener('click', () => purchase());
  document.querySelectorAll('.purchase-for-supplier').forEach((button) => button.addEventListener('click', () => purchase(button.dataset.supplier)));
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
}

async function bindSalesHistory() {
  const searchForm = document.querySelector('#sales-history-search');
  searchForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const filters = new FormData(searchForm);
    state.salesHistorySearch = String(filters.get('search') ?? '').trim();
    state.salesFrom = String(filters.get('from') ?? '');
    state.salesTo = String(filters.get('to') ?? '');
    if (state.salesFrom > state.salesTo) { toast('تاريخ البداية لازم يكون قبل تاريخ النهاية', 'error'); return; }
    state.salesHistory = [];
    state.salesHistoryTotal = 0;
    await fetchSalesHistory(0, false);
  });
  if (state.salesHistory === null) {
    state.salesHistory = [];
    await fetchSalesHistory(0, false);
    return;
  }
  document.querySelector('#sales-history-more')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    await fetchSalesHistory(state.salesHistory.length, true, button);
  });
}

async function fetchSalesHistory(offset, append, button = null) {
  try {
    const params = new URLSearchParams({ storeId: state.data.selectedStoreId, offset: String(offset), limit: '100', search: state.salesHistorySearch, from: state.salesFrom ?? new Date().toISOString().slice(0, 10), to: state.salesTo ?? new Date().toISOString().slice(0, 10) });
    const result = await api(`/api/sales?${params.toString()}`);
    state.salesHistory = append ? [...state.salesHistory, ...result.payload.sales] : result.payload.sales;
    state.salesHistoryTotal = result.payload.total;
    render();
  } catch (error) { toast(error.message, 'error'); if (button) button.disabled = false; }
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
  let root = document.querySelector('#modal-root');
  if (!root) { root = document.createElement('div'); root.id = 'modal-root'; document.body.append(root); }
  const totalReturned = sale.returns.reduce((sum, item) => sum + BigInt(item.refundAmount.amount), 0n).toString();
  root.innerHTML = `<div class="modal-backdrop"><section class="modal-card invoice-detail-card" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">تفاصيل عملية البيع</span><h2>فاتورة ${escapeHtml(sale.saleNumber)}</h2></div><button class="modal-close" data-close-modal>×</button></div><div class="invoice-detail-meta"><span>التاريخ: ${new Date(sale.createdAt).toLocaleString('ar-EG')}</span><span>البائع: ${escapeHtml(sale.cashierName)}</span><span>العميل: ${escapeHtml(sale.customerName || 'عميل نقدي')}</span></div><div class="table-scroll"><table><thead><tr><th>الصنف</th><th>كود الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>خصم الصنف</th><th>خصم الفاتورة</th><th>الصافي</th></tr></thead><tbody>${sale.items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.sku)}</td><td>${item.quantity}</td><td>${money(item.unitPrice)}</td><td>${money(item.lineDiscount)}</td><td>${money(item.cartDiscountShare)}</td><td class="table-total">${money(item.netRevenue)}</td></tr>`).join('')}</tbody></table></div><div class="invoice-detail-totals"><div><span>الإجمالي قبل الخصم</span><strong>${money(sale.subtotal)}</strong></div><div><span>إجمالي الخصم</span><strong>${money(sale.discountTotal)}</strong></div><div><span>إجمالي الفاتورة</span><strong>${money(sale.total)}</strong></div><div><span>المبلغ المدفوع</span><strong>${money(sale.paidTotal)}</strong></div><div><span>الباقي النقدي</span><strong>${money(sale.changeGiven)}</strong></div></div><h3>تفاصيل الدفع</h3><div class="invoice-detail-payments">${sale.payments.map((payment) => `<div><span>${methodLabel(payment.method)}</span><strong>${money(payment.amount)}</strong></div>`).join('')}</div>${sale.returns.length ? `<h3>المرتجعات</h3><div class="invoice-detail-payments">${sale.returns.map((item) => `<div><span>${escapeHtml(item.returnNumber)} · ${new Date(item.createdAt).toLocaleString('ar-EG')} · ${methodLabel(item.paymentMethod)}</span><strong>${money(item.refundAmount)}</strong></div>`).join('')}<div><span>إجمالي المرتجعات</span><strong>${money({ ...sale.total, amount: totalReturned })}</strong></div></div>` : ''}<div class="modal-actions"><button class="button button-secondary" data-close-modal>إغلاق</button><button class="button button-primary" type="button" data-print-invoice>طباعة الفاتورة</button></div></section></div>`;
  root.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  root.querySelector('[data-print-invoice]').addEventListener('click', () => void showThermalReceiptModal(sale.id));
}

function bindReturns() {
  document.querySelectorAll('.start-return').forEach((button) => button.addEventListener('click', () => {
    const sale = state.data.sales.find((item) => item.id === button.dataset.sale);
    if (!sale) return;
    const returnable = sale.items.filter((item) => BigInt(item.returnableQuantity ?? '0') > 0n);
    const rows = returnable.map((item) => `<div class="form-grid"><span>${escapeHtml(item.name)} · ${escapeHtml(item.sku)} · ${money(item.unitPrice)}</span><label>الكمية (المتاح ${item.returnableQuantity})<input name="qty:${item.id}" type="number" min="0" max="${item.returnableQuantity}" step="1" value="0"></label></div>`).join('');
    supplierModal(`<p>الفاتورة الأصلية: <strong>${escapeHtml(sale.saleNumber)}</strong>. المبلغ المسترد يُحسب من سعر البيع والخصم المسجلين في الفاتورة.</p>${rows}<label>طريقة رد المبلغ<select name="paymentMethod"><option value="CASH">نقدي</option><option value="CARD">بطاقة</option><option value="MOBILE">محفظة</option><option value="OTHER">أخرى</option></select></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'return-form', `/api/sales/${sale.id}/returns`, (data) => {
      const items = returnable.map((item) => ({ originalSaleItemId: item.id, quantity: data[`qty:${item.id}`] ?? '0' })).filter((item) => BigInt(item.quantity) > 0n);
      if (!items.length) throw new Error('حدد صنفًا واحدًا على الأقل للمرتجع');
      return { idempotencyKey: data.idempotencyKey, storeId: data.storeId, paymentMethod: data.paymentMethod, items };
    }, 'تم تسجيل المرتجع ورد المخزون والمبلغ');
  }));
}

function bindMonthlyExpenses() {
  document.querySelector('#new-monthly-obligation')?.addEventListener('click', () => {
    supplierModal(`<label>اسم الالتزام<input name="name" required minlength="2" maxlength="120" placeholder="إيجار المحل"></label><label>التصنيف<select name="categoryCode"><option value="RENT">إيجار</option><option value="UTILITIES">مرافق وفواتير</option><option value="TRANSPORT">نقل ومواصلات</option><option value="MAINTENANCE">صيانة</option><option value="SUPPLIES">مستلزمات تشغيل</option><option value="OTHER">أخرى</option></select></label><label>يوم الاستحقاق<input name="dueDay" type="number" min="1" max="31" value="1" required></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'monthly-obligation-form', '/api/recurring-expenses', (data) => ({ ...data, dueDay: Number(data.dueDay) }), 'تم إضافة الالتزام الشهري');
  });
  document.querySelectorAll('.confirm-monthly').forEach((button) => button.addEventListener('click', () => {
    const period = state.data.monthlyPeriod;
    supplierModal(`<p>الشهر: <strong>${String(period.month).padStart(2, '0')} / ${period.year}</strong>. سيتم إثبات المبلغ كمصروف مستحق، ولن يُخصم مرة أخرى عند السداد.</p><label>المبلغ الفعلي (${state.data.company.currency})<input name="amount" inputmode="decimal" required></label><input type="hidden" name="year" value="${period.year}"><input type="hidden" name="month" value="${period.month}">`, 'monthly-actual-form', `/api/recurring-expenses/${button.dataset.obligation}/actual`, (data) => ({ year: Number(data.year), month: Number(data.month), amount: toMinor(data.amount, currencyDecimals(state.data.company.currency)) }), 'تم إثبات المصروف وقيده كمستحق');
  }));
  document.querySelectorAll('.pay-monthly').forEach((button) => button.addEventListener('click', () => {
    const decimals = currencyDecimals(state.data.company.currency), digits = BigInt(button.dataset.remaining).toString().padStart(decimals + 1, '0');
    const maxAmount = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
    supplierModal(`<p>المتبقي على الالتزام: <strong>${money({ amount: button.dataset.remaining, currency: state.data.company.currency, decimals })}</strong></p><label>مبلغ السداد<input name="amount" inputmode="decimal" max="${maxAmount}" required></label><label>طريقة الدفع<select name="paymentMethod"><option value="CASH_DRAWER">درج النقدية</option><option value="CASH_SAFE">الخزينة</option><option value="BANK_TRANSFER">تحويل بنكي</option></select></label><label>رقم مرجعي<input name="referenceNumber" maxlength="80"></label><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'monthly-payment-form', `/api/monthly-expenses/${button.dataset.actual}/payments`, (data) => ({ ...data, amount: toMinor(data.amount, decimals) }), 'تم تسجيل السداد من رصيد الالتزام');
  }));
}

function currencyDecimals(currency) {
  return ['JPY', 'KRW'].includes(currency) ? 0 : ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency) ? 3 : 2;
}

function bindShell() {
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => {
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
    if (!term) { state.page = 'products'; render(); return; }
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
        state.page = 'products';
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
  if (state.page === 'monthly-expenses') bindMonthlyExpenses();
  if (state.page === 'expenses') bindExpenses();
  if (state.page === 'reports') bindProfitLoss();
  if (state.page === 'top-products') bindTopProducts();
  if (state.page === 'backups') bindBackups();
  if (state.page === 'users') bindUsers(); if (state.page === 'audit-logs') bindAuditLogs(); if (state.page === 'accounting') bindAccounting();
  document.addEventListener('keydown', handleShortcuts, { once: true });
}

function bindAuditLogs() { const key = `${state.data.selectedStoreId}:audit`; if (state.auditLogsKey === key && state.auditLogs) return; state.auditLogsKey = key; void api(`/api/audit-logs?storeId=${encodeURIComponent(state.data.selectedStoreId)}&limit=100`).then((result) => { state.auditLogs = result.entries; state.auditChainVerification = result.chainVerification; render(); }).catch((error) => { state.auditLogsKey = null; toast(error.message, 'error'); }); }
async function showThermalReceiptModal(saleId) { try { const { receipt } = await api(`/api/sales/${encodeURIComponent(saleId)}/receipt?width=80mm`); let root = document.querySelector('#modal-root'); if (!root) { root = document.createElement('div'); root.id = 'modal-root'; document.body.append(root); } root.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">معاينة الإيصال الحراري (${escapeHtml(receipt.width)})</span><h2>${escapeHtml(receipt.companyName)} — ${escapeHtml(receipt.storeName)}</h2></div><button class="modal-close" data-close-modal>×</button></div><div class="invoice-detail-meta"><span>إيصال: ${escapeHtml(receipt.saleNumber)}</span><span>الكاشير: ${escapeHtml(receipt.cashierName)}</span><span>${new Date(receipt.createdAt).toLocaleString('ar-EG')}</span></div><div class="table-scroll"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${receipt.items.map((item) => `<tr><td>${escapeHtml(item.productName)}</td><td>${escapeHtml(item.quantity)}</td><td>${money(item.unitPrice)}</td><td>${money(item.lineTotal)}</td></tr>`).join('')}</tbody></table></div><div class="invoice-detail-totals"><div><span>الإجمالي المطلوب</span><strong>${money(receipt.total)}</strong></div><div><span>المدفوع</span><strong>${money(receipt.paidTotal)}</strong></div><div><span>الباقي</span><strong>${money(receipt.changeGiven)}</strong></div></div><div class="modal-actions"><button type="button" class="button button-secondary" data-close-modal>إغلاق</button><button type="button" class="button button-primary" id="confirm-thermal-print">طباعة الآن</button></div></section></div>`; root.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => { root.innerHTML = ''; })); root.querySelector('#confirm-thermal-print')?.addEventListener('click', () => window.print()); } catch (error) { toast(error.message, 'error'); } }
function bindAccounting() { document.querySelector('#close-shift-btn')?.addEventListener('click', () => { const decimals = currencyDecimals(state.data.company.currency); const bookLabel = state.data.drawerBookBalance ? money(state.data.drawerBookBalance) : '—'; supplierModal(`<p>الرصيد الدفتري الحالي لدرج النقدية (1010): <strong>${bookLabel}</strong>. أدخل النقدية الفعلية المعدودة في الدرج لإثبات التطابق أو تسوية العجز/الزيادة محاسبيًا.</p><label>النقدية الفعلية في الدرج (${state.data.company.currency})<input name="actualCashAmount" inputmode="decimal" required></label><label>ملاحظات التقفيل (اختياري)<input name="notes" maxlength="300"></label><input type="hidden" name="storeId" value="${state.data.selectedStoreId}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}">`, 'shift-close-form', '/api/accounting/shift-close', (data) => ({ ...data, actualCashAmount: toMinor(data.actualCashAmount, decimals) }), 'تم تقفيل الوردية وتسوية رصيد درج النقدية'); }); document.querySelectorAll('.close-period-btn').forEach((btn) => btn.addEventListener('click', async () => { if (!window.confirm(`هل تريد إقفال الفترة المحاسبية (${btn.dataset.periodName}) نهائيًا؟ لا يمكن تسجيل قيود بتاريخ قديم داخلها بعد الإقفال.`)) return; btn.disabled = true; try { await api('/api/accounting/periods/close', { method: 'POST', body: JSON.stringify({ periodId: btn.dataset.periodId }) }); await loadData(state.data.selectedStoreId); render(); toast('تم إقفال الفترة المحاسبية بنجاح'); } catch (error) { toast(error.message, 'error'); btn.disabled = false; } })); }
function backupView() {
  return `<section class="panel"><div class="panel-heading"><div><h3>\u0646\u0633\u062e\u0629 \u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629 \u0645\u0634\u0641\u0631\u0629</h3><p>\u0646\u0633\u062e\u0629 \u0645\u062a\u0633\u0642\u0629 \u0645\u0646 \u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0646\u0634\u0637\u0629.</p></div></div><div class="empty-row">\u0627\u0644\u0646\u0633\u062e\u0629 \u0645\u0634\u0641\u0631\u0629 \u0628\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u0644\u064a \u0647\u062a\u062e\u062a\u0627\u0631\u0647\u0627. \u0627\u062d\u0641\u0638 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0641\u064a \u0645\u0643\u0627\u0646 \u0622\u0645\u0646 \u0645\u0646\u0641\u0635\u0644\u061b \u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0633\u062a\u0639\u0627\u062f\u062a\u0647\u0627 \u0645\u0646 \u0627\u0644\u0646\u0633\u062e\u0629.</div><form id="backup-export-form" class="form-stack"><label>\u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u0644\u0644\u062a\u0634\u0641\u064a\u0631<input name="passphrase" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><label>\u0623\u0643\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631<input name="confirmPassphrase" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><button class="button button-primary" type="submit">\u062a\u0646\u0632\u064a\u0644 \u0646\u0633\u062e\u0629 \u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629</button></form><hr><h3>\u0627\u0633\u062a\u0639\u0627\u062f\u0629 \u0646\u0633\u062e\u0629</h3><p>\u0633\u064a\u062a\u0645 \u0627\u0633\u062a\u0628\u062f\u0627\u0644 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062d\u0644 \u0627\u0644\u062d\u0627\u0644\u064a\u0629 \u0648\u0625\u0639\u0627\u062f\u0629 \u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u0646\u0638\u0627\u0645. \u0627\u0633\u062a\u0639\u0645\u0644 \u0646\u0633\u062e\u0629 \u0644\u0646\u0641\u0633 \u0627\u0644\u0634\u0631\u0643\u0629.</p><form id="backup-restore-form" class="form-stack"><label>\u0645\u0644\u0641 \u0627\u0644\u0646\u0633\u062e\u0629<input name="archive" type="file" accept=".rfbackup,application/octet-stream" required></label><label>\u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u0627\u0644\u0646\u0633\u062e\u0629<input name="passphrase" type="password" minlength="12" maxlength="256" autocomplete="current-password" required></label><label><input name="confirmReplace" type="checkbox" required> \u0623\u0641\u0647\u0645 \u0623\u0646 \u0627\u0644\u0627\u0633\u062a\u0639\u0627\u062f\u0629 \u0633\u062a\u0633\u062a\u0628\u062f\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a.</label><button class="button button-danger" type="submit">\u0627\u0633\u062a\u0639\u0627\u062f\u0629 \u0627\u0644\u0646\u0633\u062e\u0629</button></form></section>`;
}

function bindBackups() {
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

function bindTopProducts() {
  document.querySelector('#analytics-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get('from') ?? ''), to = String(data.get('to') ?? '');
    if (from > to) { toast('تاريخ البداية لازم يكون قبل تاريخ النهاية', 'error'); return; }
    state.analyticsFrom = from;
    state.analyticsTo = to;
    state.productStats = null;
    state.supplierStats = null;
    state.analyticsKey = null;
    render();
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
  document.querySelector('#profit-loss-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
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

function bindProducts() {
  bindLocalSearch();
  document.querySelector('#new-store-btn')?.addEventListener('click', () => supplierModal('<label>اسم الفرع الجديد<input name="name" required minlength="2" maxlength="100" placeholder="مثال: فرع المعادي"></label><label>كود الفرع<input name="code" required minlength="2" maxlength="20" pattern="[A-Za-z0-9_-]+" placeholder="MAADI"></label><label>العنوان (اختياري)<input name="address" maxlength="240"></label><label>الهاتف (اختياري)<input name="phone" maxlength="40"></label>', 'store-form', '/api/stores', (d) => d, 'تم إضافة الفرع الجديد بنجاح'));
  document.querySelector('#transfer-stock-btn')?.addEventListener('click', () => { const otherStores = state.data.stores.filter((s) => s.id !== state.data.selectedStoreId); const variants = state.data.products.filter((p) => p.itemKind === 'PRODUCT' && p.isActive).flatMap((p) => p.variants.filter((v) => v.isActive && BigInt(v.quantity) > 0n).map((v) => ({ id: v.id, label: `${p.name} (${v.sku}) — متاح ${v.quantity}` }))); if (!variants.length) { toast('لا توجد أصناف بها رصيد متاح للتحويل في الفرع الحالي', 'error'); return; } supplierModal(`<p>التحويل من الفرع الحالي: <strong>${escapeHtml(state.data.stores.find((s) => s.id === state.data.selectedStoreId)?.name ?? '')}</strong></p><label>إلى الفرع<select name="toStoreId" required>${otherStores.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></label><label>الصنف والنسخة<select name="variantId" required>${variants.map((v) => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join('')}</select></label><label>الكمية المحولة<input name="quantity" type="number" min="1" step="1" value="1" required></label><input type="hidden" name="fromStoreId" value="${state.data.selectedStoreId}">`, 'transfer-form', '/api/inventory/transfer', (d) => d, 'تم تحويل المخزون بين الفروع بنجاح'); });
  const open = () => showProductModal();
  document.querySelector('#new-product')?.addEventListener('click', open);
  document.querySelector('#add-category')?.addEventListener('click', () => showCategoryModal());
  document.querySelector('#empty-new-product')?.addEventListener('click', open);
  document.querySelectorAll('.product-edit').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.productId);
    if (product) showProductEditModal(product);
  }));
  document.querySelectorAll('.product-delete').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/products/${encodeURIComponent(button.dataset.productId)}`, { method: 'DELETE' });
      await loadData(state.data.selectedStoreId);
      render();
      toast('تم حذف المنتج من قائمة البيع مع الاحتفاظ بسجله وفواتيره');
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  }));
}

function decimalPrice(value) {
  const amount = BigInt(value.amount);
  const decimals = value.decimals;
  if (!decimals) return amount.toString();
  const digits = amount.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function showProductEditModal(product) {
  const modal = document.querySelector('#modal-root');
  const currency = state.data.company.currency;
  const categoryChoices = state.data.categories.map((category) => `<option value="${category.id}" ${category.id === product.categoryId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="product-edit-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">الكتالوج</span><h2 id="product-edit-title">تعديل المنتج</h2></div><button class="modal-close" data-close-modal>×</button></div><form id="product-edit-form" class="form-stack modal-form"><label>اسم المنتج<input name="name" required minlength="2" maxlength="120" value="${escapeHtml(product.name)}"></label><div class="form-grid"><label>كود المنتج<input name="sku" required maxlength="64" value="${escapeHtml(product.sku)}"></label><label>الفئة<select name="categoryId"><option value="">بدون فئة</option>${categoryChoices}</select></label></div><div class="form-grid"><label>الماركة<input name="brand" maxlength="100" value="${escapeHtml(product.brand ?? '')}"></label><label>رابط الصورة<input name="imagePath" type="url" maxlength="300" value="${escapeHtml(product.imagePath ?? '')}"></label></div><label>وصف المنتج<textarea name="description" maxlength="2000" rows="2">${escapeHtml(product.description ?? '')}</textarea></label><div class="table-scroll"><table class="variant-matrix-table"><thead><tr><th>متاحة</th><th>التركيبة</th><th>كود النسخة</th><th>السعر (${currency})</th><th>حد الطلب</th></tr></thead><tbody>${product.variants.filter((variant) => variant.isActive).map((variant) => `<tr data-variant-id="${variant.id}"><td><input data-edit-active type="checkbox" checked aria-label="إبقاء التركيبة متاحة"></td><td>${escapeHtml(Object.entries(variant.attributes ?? {}).map(([key, value]) => `${product.options?.find((option) => option.key === key)?.name ?? key}: ${value}`).join(' · ') || product.name)}</td><td><input data-edit-sku maxlength="64" required value="${escapeHtml(variant.sku)}"></td><td><input data-edit-price inputmode="decimal" required value="${escapeHtml(decimalPrice(variant.price))}"></td><td><input data-edit-reorder type="number" min="0" step="1" required value="${escapeHtml(variant.reorderPoint)}"></td></tr>`).join('')}</tbody></table></div><div id="new-variant-rows" class="form-stack"></div>${product.options?.length ? '<button type="button" class="button button-secondary" id="add-edit-variant">إضافة تركيبة من الخيارات الحالية</button>' : ''}<div class="modal-actions"><button type="button" class="button button-secondary" data-close-modal>إلغاء</button><button type="submit" class="button button-primary">حفظ التعديلات</button></div></form></section></div>`;
  modal.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { modal.innerHTML = ''; }));
  const newVariantRows = modal.querySelector('#new-variant-rows');
  modal.querySelector('#add-edit-variant')?.addEventListener('click', () => {
    const row = document.createElement('div'); row.className = 'form-grid edit-new-variant';
    const selectors = product.options.map((option) => `<label>${escapeHtml(option.name)}<select data-new-attribute="${escapeHtml(option.key)}">${option.values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}</select></label>`).join('');
    row.innerHTML = `${selectors}<label>كود النسخة<input data-new-sku required maxlength="64"></label><label>السعر (${currency})<input data-new-price inputmode="decimal" required></label><label>حد الطلب<input data-new-reorder type="number" min="0" value="5" required></label><button type="button" class="text-action" data-remove-new>حذف</button>`;
    row.querySelector('[data-remove-new]').addEventListener('click', () => row.remove()); newVariantRows.append(row);
  });
  modal.querySelector('#product-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      const variants = [...form.querySelectorAll('[data-variant-id]')].filter((row) => row.querySelector('[data-edit-active]').checked).map((row) => ({
        id: row.dataset.variantId,
        sku: row.querySelector('[data-edit-sku]').value.trim(),
        attributes: product.variants.find((item) => item.id === row.dataset.variantId)?.attributes ?? {},
        retailPrice: toMinor(row.querySelector('[data-edit-price]').value, currencyDecimals(currency)),
        reorderPoint: row.querySelector('[data-edit-reorder]').value,
      }));
      for (const row of newVariantRows?.querySelectorAll('.edit-new-variant') ?? []) variants.push({ sku: row.querySelector('[data-new-sku]').value.trim(), attributes: Object.fromEntries([...row.querySelectorAll('[data-new-attribute]')].map((select) => [select.dataset.newAttribute, select.value])), retailPrice: toMinor(row.querySelector('[data-new-price]').value, currencyDecimals(currency)), reorderPoint: row.querySelector('[data-new-reorder]').value });
      await api(`/api/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: JSON.stringify({ name: data.get('name'), sku: data.get('sku'), categoryId: data.get('categoryId') || null, description: data.get('description') || null, brand: data.get('brand') || null, imagePath: data.get('imagePath') || null, options: product.options ?? [], variants }) });
      await loadData(state.data.selectedStoreId);
      render();
      toast('تم حفظ تعديلات المنتج');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
}

function showCategoryModal(onCreated = null) {
  const root = document.querySelector('#modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop category-modal-overlay';
  overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="category-modal-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">الكتالوج</span><h2 id="category-modal-title">إضافة فئة</h2></div><button type="button" class="modal-close" data-close-category>×</button></div><form id="category-form" class="form-stack modal-form"><label>اسم الفئة<input name="name" required minlength="2" maxlength="100" autofocus></label><div class="modal-actions"><button type="button" class="button button-secondary" data-close-category>إلغاء</button><button type="submit" class="button button-primary">حفظ الفئة</button></div></form></section>`;
  root.append(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-close-category]').forEach((button) => button.addEventListener('click', close));
  overlay.querySelector('#category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const name = new FormData(form).get('name');
      const result = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
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
  const modal = document.querySelector('#modal-root');
  const currency = state.data.company.currency;
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="product-modal-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">الكتالوج</span><h2 id="product-modal-title">إضافة منتج جديد</h2></div><button class="modal-close" data-close-modal>×</button></div><form id="product-form" class="form-stack modal-form"><label>اسم المنتج<input name="name" required minlength="2" maxlength="120" placeholder="مثال: شنطة يومية"></label><label>كود المنتج<input name="sku" required maxlength="64" placeholder="BAG-001"></label><div class="form-grid"><label>الماركة (اختياري)<input name="brand" maxlength="100"></label><label>السعر الافتراضي (${currency})<input name="price" required inputmode="decimal" placeholder="0.00"></label></div><label>وصف المنتج (اختياري)<textarea name="description" maxlength="2000" rows="2"></textarea></label><label>رابط صورة المنتج (اختياري)<input name="imagePath" type="url" maxlength="300" placeholder="https://..."></label><div class="form-grid"><label>حد إعادة الطلب الافتراضي<input name="reorderPoint" type="number" required min="0" step="1" value="5"></label></div><div class="variant-options-section"><div><strong>خيارات المنتج</strong><small>أضف أي خاصية بالاسم والقيم. النظام ينشئ التركيبات تلقائيًا (حتى 50 تركيبة).</small></div><div id="product-option-rows"></div><button type="button" class="button button-secondary" id="add-product-option">إضافة خاصية</button><p class="variant-options-note">كل تركيبة لها SKU وباركود اختياري ومخزون مستقل. يمكنك استلام خليط الكميات لاحقًا من شاشة المشتريات أو المخزون.</p><div id="variant-matrix-notice" role="status"></div><div id="variant-matrix"></div></div><div class="single-variant-sku"><label>كود النسخة<input name="variantSku" required maxlength="64" placeholder="BAG-001-STD"></label><label>باركود (اختياري)<input name="variantBarcode" maxlength="64"></label><small>لو المنتج بدون خيارات، أنشئ له نسخة واحدة.</small></div><div class="modal-actions"><button type="button" class="button button-secondary" data-close-modal>إلغاء</button><button type="submit" class="button button-primary">حفظ المنتج</button></div></form></section></div>`;
  const productForm = modal.querySelector('#product-form');
  const categoryLabel = document.createElement('label');
  categoryLabel.innerHTML = `<span>الفئة</span><div class="category-select-row"><select name="categoryId"><option value="">بدون فئة</option>${state.data.categories.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('')}</select><button type="button" class="text-action" id="add-category-inline">إضافة فئة</button></div>`;
  productForm.prepend(categoryLabel);
  categoryLabel.querySelector('#add-category-inline').addEventListener('click', () => showCategoryModal());
  const matrix = productForm.querySelector('#variant-matrix');
  const notice = productForm.querySelector('#variant-matrix-notice');
  const singleSkuField = productForm.querySelector('.single-variant-sku');
  const optionsSection = productForm.querySelector('.variant-options-section');
  const optionRows = productForm.querySelector('#product-option-rows');
  const addOptionRow = (name = '', values = '') => {
    if (optionRows.children.length >= 8) { toast('الحد الأقصى 8 خيارات'); return; }
    const row = document.createElement('div'); row.className = 'variant-option-row';
    row.innerHTML = '<input data-option-name maxlength="64" placeholder="اسم الخاصية، مثل اللون"><input data-option-values maxlength="500" placeholder="القيم مفصولة بفواصل، مثل أسود، أبيض"><button type="button" class="text-action" data-remove-option aria-label="حذف الخاصية">حذف</button>';
    row.querySelector('[data-option-name]').value = name; row.querySelector('[data-option-values]').value = values;
    row.addEventListener('input', buildMatrix); row.querySelector('[data-remove-option]').addEventListener('click', () => { row.remove(); buildMatrix(); });
    optionRows.append(row);
  };
  productForm.querySelector('#add-product-option').addEventListener('click', () => { addOptionRow(); buildMatrix(); });
  let lastDefaultPrice = productForm.elements.namedItem('price').value;
  let lastDefaultReorderPoint = productForm.elements.namedItem('reorderPoint').value;
  const buildMatrix = () => {
    const previous = new Map([...matrix.querySelectorAll('[data-variant-key]')].map((row) => [row.dataset.variantKey, {
      sku: row.querySelector('[data-variant-sku]').value,
      barcode: row.querySelector('[data-variant-barcode]')?.value ?? '',
      price: row.querySelector('[data-variant-price]').value,
      reorderPoint: row.querySelector('[data-variant-reorder]').value,
      enabled: row.querySelector('[data-variant-enabled]').checked,
    }]));
    const options = [...optionRows.children].map((row, index) => ({ name: row.querySelector('[data-option-name]').value.trim(), key: `option_${index + 1}`, values: row.querySelector('[data-option-values]').value.split(',').map((value) => value.trim()).filter(Boolean) })).filter((option) => option.name || option.values.length);
    const active = options.filter((option) => option.values.length);
    const missingKeys = options.some((option) => !option.name && option.values.length);
    const duplicateKeys = new Set(active.map((option) => option.name.toLocaleLowerCase())).size !== active.length;
    const duplicateValues = active.some((option) => new Set(option.values.map((value) => value.toLocaleLowerCase())).size !== option.values.length);
    const oversizedValues = active.some((option) => option.values.some((value) => value.length > 64));
    const missingValues = options.some((option) => option.key && !option.values.length);
    const combinationCount = active.reduce((total, option) => total * option.values.length, 1);
    const tooMany = combinationCount > 50;
    const combinations = [];
    const expand = (position, attributes) => {
      if (position === active.length) { combinations.push(attributes); return; }
      const option = active[position];
      for (const value of option.values) expand(position + 1, { ...attributes, [option.key]: value });
    };
    if (active.length && !tooMany) expand(0, {});
    if (missingKeys || duplicateKeys || duplicateValues || oversizedValues || missingValues || tooMany) {
      notice.textContent = missingKeys ? 'اكتب اسم الخاصية لكل مجموعة قيم.' : duplicateKeys ? 'لا تكرر اسم الخاصية نفسها.' : duplicateValues ? 'احذف القيم المكررة داخل الخاصية.' : oversizedValues ? 'كل قيمة للخاصية يجب ألا تتجاوز 64 حرفًا.' : missingValues ? 'اكتب قيمة واحدة على الأقل لكل خاصية اخترتها.' : 'التركيبات أكثر من الحد المسموح (50). قلل الخيارات.';
      matrix.innerHTML = '';
      return;
    }
    notice.textContent = '';
    const hasVariants = combinations.length > 0;
    optionsSection.hidden = false;
    matrix.hidden = !hasVariants;
    singleSkuField.hidden = hasVariants;
    productForm.elements.namedItem('variantSku').required = !hasVariants;
    if (!hasVariants) { matrix.innerHTML = ''; return; }
    const usedSkus = new Set([...previous.values()].map((item) => item.sku.toLocaleLowerCase()));
    matrix.innerHTML = `<div class="variant-matrix-scroll"><table class="variant-matrix-table"><thead><tr><th>متاحة</th><th>النسخة</th><th>SKU</th><th>باركود (اختياري)</th><th>السعر (${currency})</th><th>حد الطلب</th></tr></thead><tbody>${combinations.map((attributes, index) => {
      const key = JSON.stringify(attributes), saved = previous.get(key);
      const label = Object.values(attributes).map((value) => escapeHtml(String(value))).join(' · ');
      let suffix = index + 1, generatedSku = '';
      const baseSku = (productForm.elements.namedItem('sku').value.trim() || 'ITEM').slice(0, 61);
      do { generatedSku = `${baseSku}-${String(suffix++).padStart(2, '0')}`; } while (usedSkus.has(generatedSku.toLocaleLowerCase()));
      const sku = saved?.sku || generatedSku;
      usedSkus.add(sku.toLocaleLowerCase());
      const price = saved?.price || productForm.elements.namedItem('price').value;
      const reorderPoint = saved?.reorderPoint ?? productForm.elements.namedItem('reorderPoint').value;
      return `<tr data-variant-key="${escapeHtml(key)}"><td><input data-variant-enabled type="checkbox" aria-label="إضافة النسخة ${label}" ${saved?.enabled === false ? '' : 'checked'}></td><td><strong>${label}</strong></td><td><input data-variant-sku maxlength="64" required value="${escapeHtml(sku)}"></td><td><input data-variant-barcode maxlength="64" value="${escapeHtml(saved?.barcode ?? '')}"></td><td><input data-variant-price inputmode="decimal" required value="${escapeHtml(price)}"></td><td><input data-variant-reorder type="number" min="0" step="1" required value="${escapeHtml(reorderPoint)}"></td></tr>`;
    }).join('')}</tbody></table></div>`;
  };
  addOptionRow(); addOptionRow();
  productForm.elements.namedItem('sku').addEventListener('change', buildMatrix);
  productForm.elements.namedItem('price').addEventListener('change', (event) => {
    for (const row of matrix.querySelectorAll('[data-variant-price]')) {
      if (row.value === lastDefaultPrice) row.value = event.currentTarget.value;
    }
    lastDefaultPrice = event.currentTarget.value;
  });
  productForm.elements.namedItem('reorderPoint').addEventListener('change', (event) => {
    for (const row of matrix.querySelectorAll('[data-variant-reorder]')) {
      if (row.value === lastDefaultReorderPoint) row.value = event.currentTarget.value;
    }
    lastDefaultReorderPoint = event.currentTarget.value;
  });
  buildMatrix();
  modal.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => { modal.innerHTML = ''; }));
  productForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(productForm);
    const submit = productForm.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      buildMatrix();
      if (notice.textContent) throw new Error(notice.textContent);
      const rows = [...matrix.querySelectorAll('[data-variant-key]')];
      const enabledRows = rows.filter((row) => row.querySelector('[data-variant-enabled]').checked);
      if (rows.length && !enabledRows.length) throw new Error('اختار تركيبة مقاس أو لون واحدة على الأقل.');
      const options = [...optionRows.children].map((row, index) => ({ key: `option_${index + 1}`, name: row.querySelector('[data-option-name]').value.trim(), values: row.querySelector('[data-option-values]').value.split(',').map((value) => value.trim()).filter(Boolean) })).filter((option) => option.name && option.values.length);
      const variants = rows.length ? enabledRows.map((row) => ({
        sku: row.querySelector('[data-variant-sku]').value.trim(),
        barcode: row.querySelector('[data-variant-barcode]').value.trim() || undefined,
        attributes: JSON.parse(row.dataset.variantKey),
        retailPrice: toMinor(row.querySelector('[data-variant-price]').value, currencyDecimals(currency)),
        reorderPoint: row.querySelector('[data-variant-reorder]').value,
      })) : [{ sku: form.get('variantSku'), barcode: form.get('variantBarcode') || undefined, retailPrice: toMinor(form.get('price'), currencyDecimals(currency)), reorderPoint: String(form.get('reorderPoint')) }];
      await api('/api/products', { method: 'POST', body: JSON.stringify({ name: form.get('name'), sku: form.get('sku'), itemKind: 'PRODUCT', categoryId: form.get('categoryId') || undefined, brand: form.get('brand') || undefined, description: form.get('description') || undefined, imagePath: form.get('imagePath') || undefined, options, hasVariants: rows.length > 0, variants }) });
      await loadData(state.data.selectedStoreId);
      state.query = '';
      render();
      toast('تم حفظ المنتج ونسخه في قاعدة البيانات');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
}

function bindInventory() {
  bindLocalSearch();
  document.querySelector('#new-store-btn')?.addEventListener('click', () => supplierModal('<label>اسم الفرع الجديد<input name="name" required minlength="2" maxlength="100" placeholder="مثال: فرع المعادي"></label><label>كود الفرع<input name="code" required minlength="2" maxlength="20" pattern="[A-Za-z0-9_-]+" placeholder="MAADI"></label><label>العنوان (اختياري)<input name="address" maxlength="240"></label><label>الهاتف (اختياري)<input name="phone" maxlength="40"></label>', 'store-form', '/api/stores', (d) => d, 'تم إضافة الفرع الجديد بنجاح'));
  document.querySelector('#transfer-stock-btn')?.addEventListener('click', () => { const otherStores = state.data.stores.filter((s) => s.id !== state.data.selectedStoreId); const variants = state.data.products.filter((p) => p.itemKind === 'PRODUCT' && p.isActive).flatMap((p) => p.variants.filter((v) => v.isActive && BigInt(v.quantity) > 0n).map((v) => ({ id: v.id, label: `${p.name} (${v.sku}) — متاح ${v.quantity}` }))); if (!variants.length) { toast('لا توجد أصناف بها رصيد متاح للتحويل في الفرع الحالي', 'error'); return; } supplierModal(`<p>التحويل من الفرع الحالي: <strong>${escapeHtml(state.data.stores.find((s) => s.id === state.data.selectedStoreId)?.name ?? '')}</strong></p><label>إلى الفرع<select name="toStoreId" required>${otherStores.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></label><label>الصنف والنسخة<select name="variantId" required>${variants.map((v) => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join('')}</select></label><label>الكمية المحولة<input name="quantity" type="number" min="1" step="1" value="1" required></label><input type="hidden" name="fromStoreId" value="${state.data.selectedStoreId}">`, 'transfer-form', '/api/inventory/transfer', (d) => d, 'تم تحويل المخزون بين الفروع بنجاح'); });
  document.querySelectorAll('.inventory-product-details').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.productId);
    if (product) showInventoryProductDetails(product);
  }));
}

function showInventoryProductDetails(product) {
  const modal = document.querySelector('#modal-root');
  const variants = product.variants.filter((variant) => variant.isActive);
  const total = variants.reduce((sum, variant) => sum + BigInt(variant.quantity), 0n);
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card product-variants-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-product-title"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">تفاصيل المخزون</span><h2 id="inventory-product-title">${escapeHtml(product.name)}</h2><p>إجمالي الرصيد: <strong>${total}</strong> قطعة · ${variants.length} تركيبة</p></div><button type="button" class="modal-close" data-close-inventory-details aria-label="إغلاق">×</button></div>${variants.length ? `<div class="table-scroll"><table><thead><tr><th>التركيبة</th><th>SKU</th><th>الكمية</th><th>حد التنبيه</th><th>متوسط التكلفة</th><th>الحالة</th>${state.data.capabilities.canManageCatalog ? '<th>الإجراء</th>' : ''}</tr></thead><tbody>${variants.map((variant) => { const label = Object.entries(variant.attributes ?? {}).map(([key, value]) => `${product.options?.find((option) => option.key === key)?.name ?? key}: ${value}`).join(' · ') || 'النسخة الأساسية'; const low = BigInt(variant.quantity) <= BigInt(variant.reorderPoint); const removeAction = state.data.capabilities.canManageCatalog ? `<td>${BigInt(variant.quantity) === 0n ? `<button type="button" class="text-action product-delete" data-remove-variant="${variant.id}">حذف</button>` : '<small>صفّر الرصيد أولًا للحذف</small>'}</td>` : ''; return `<tr><td><strong>${escapeHtml(label)}</strong></td><td><span class="sku-code">${escapeHtml(variant.sku)}</span></td><td><strong>${variant.quantity}</strong></td><td>${variant.reorderPoint}</td><td>${variant.wac ? money(variant.wac) : '—'}</td><td>${low ? '<span class="status-pill status-low">مخزون منخفض</span>' : '<span class="status-pill status-complete">متوفر</span>'}</td>${removeAction}</tr>`; }).join('')}</tbody></table></div>` : '<div class="empty-row">لا توجد تركيبات نشطة لهذا المنتج.</div>'}<div class="modal-actions"><button type="button" class="button button-secondary" data-close-inventory-details>إغلاق</button></div></section></div>`;
  modal.querySelectorAll('[data-close-inventory-details]').forEach((button) => button.addEventListener('click', () => { modal.innerHTML = ''; }));
  modal.querySelectorAll('[data-remove-variant]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(button.dataset.removeVariant)}`, { method: 'DELETE' });
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
  document.querySelectorAll('[data-pick-product]').forEach((button) => button.addEventListener('click', () => {
    const product = state.data.products.find((item) => item.id === button.dataset.pickProduct);
    if (!product) return;
    const variants = product.variants.filter((variant) => variant.isActive);
    if (variants.length === 1) { addToCart(variants[0].id); return; }
    const modal = document.querySelector('#modal-root');
    modal.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow eyebrow-dark">اختيار التركيبة</span><h2>${escapeHtml(product.name)}</h2></div><button class="modal-close" data-close-modal>×</button></div><div class="form-stack">${variants.map((variant) => { const label = Object.entries(variant.attributes ?? {}).map(([key, value]) => `${product.options?.find((option) => option.key === key)?.name ?? key}: ${value}`).join(' · ') || variant.sku; const unavailable = product.itemKind === 'PRODUCT' && BigInt(variant.quantity) <= 0n; return `<button class="button button-secondary" data-pos-variant="${variant.id}" ${unavailable ? 'disabled' : ''}>${escapeHtml(label)} · ${escapeHtml(variant.sku)} · ${money(variant.price)} · متاح ${variant.quantity}</button>`; }).join('')}</div></section></div>`;
    modal.querySelector('[data-close-modal]').addEventListener('click', () => { modal.innerHTML = ''; });
    modal.querySelectorAll('[data-pos-variant]').forEach((choice) => choice.addEventListener('click', () => { const id = choice.dataset.posVariant; modal.innerHTML = ''; addToCart(id); }));
  }));
  document.querySelectorAll('[data-qty]').forEach((button) => button.addEventListener('click', () => changeQuantity(button.dataset.qty, Number(button.dataset.delta))));
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart = state.cart.filter((item) => item.variantId !== button.dataset.remove); render(); }));
  document.querySelector('#clear-cart')?.addEventListener('click', () => { state.cart = []; render(); });
  document.querySelectorAll('[data-method]').forEach((button) => button.addEventListener('click', () => { state.paymentMethod = button.dataset.method; render(); }));
  document.querySelector('#checkout-button')?.addEventListener('click', doCheckout);
}

function addToCart(variantId) {
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
    const optionLabel = Object.entries(variant.attributes ?? {}).map(([key, value]) => `${product.options?.find((option) => option.key === key)?.name ?? key}: ${value}`).join(' · ');
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
  if (!state.cart.length || state.isSaving) return;
  const button = document.querySelector('#checkout-button');
  button.disabled = true;
  state.isSaving = true;
  try {
    const totalMinor = state.cart.reduce((sum, item) => sum + BigInt(item.price.amount) * BigInt(item.quantity), 0n).toString();
    const result = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ storeId: state.data.selectedStoreId, idempotencyKey: crypto.randomUUID(), items: state.cart.map((item) => ({ variantId: item.variantId, quantity: String(item.quantity) })), payment: { method: state.paymentMethod, amount: totalMinor } }) });
    state.cart = [];
    state.isSaving = false;
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
