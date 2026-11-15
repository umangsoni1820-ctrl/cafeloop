import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Coffee, CupSoda, LayoutDashboard, LogOut, Settings2, Sparkles, UsersRound, Gift, QrCode } from 'lucide-react';
import { api } from './lib.js';
import { CustomerOrder, CustomerCard } from './customer.jsx';
import { Dashboard, Comeback, Customers, Rewards, Settings, QrPrint } from './owner.jsx';
import { AuthContext, useAuth } from './auth.jsx';
import './styles.css';

function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ ready: false, owner: null, cafe: null });
  const refresh = async () => {
    try {
      const data = await api('/api/auth/me');
      setAuth({ ready: true, owner: data.owner, cafe: data.cafe });
      return data;
    } catch {
      setAuth({ ready: true, owner: null, cafe: null });
      return null;
    }
  };
  useEffect(() => { void refresh(); }, []);
  const value = useMemo(() => ({ ...auth, refresh, accept: (data) => setAuth({ ready: true, owner: data.owner, cafe: data.cafe }), clear: () => setAuth({ ready: true, owner: null, cafe: null }) }), [auth]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function Protected() {
  const auth = useAuth();
  const location = useLocation();
  if (!auth.ready) return <div className="full-loading"><span className="loader" /></div>;
  if (!auth.owner) return <Navigate to="/owner/login" state={{ from: location.pathname }} replace />;
  return <Outlet />;
}

function AuthForm({ mode }) {
  const isSetup = mode === 'setup';
  const auth = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ cafeName: '', ownerEmail: '', password: '', currency: 'INR', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const onChange = (event) => setForm((value) => ({ ...value, [event.target.name]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = isSetup ? form : { email: form.ownerEmail, password: form.password };
      const data = await api(`/api/auth/${isSetup ? 'setup' : 'login'}`, { method: 'POST', body });
      auth.accept(data); navigate('/owner/dashboard', { replace: true });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <main className="auth-page">
    <div className="auth-art">
      <div className="auth-art-top"><Brand /></div>
      <div className="auth-quote">
        <span className="eyebrow eyebrow-light">THE NEIGHBOURHOOD CAFE, REIMAGINED</span>
        <h1>Make every<br />coffee count.</h1>
        <p>Turn a first sip into a familiar face, one thoughtful visit at a time.</p>
        <div className="quote-stamp-row"><span>01</span><span>02</span><span>03</span><span>04</span><span className="stamp-last"><Coffee size={16} /></span></div>
        <small>Good coffee. Better regulars.</small>
      </div>
      <span className="auth-art-note">CafeLoop · Independent by nature</span>
      <div className="auth-abstract bean bean-one" /><div className="auth-abstract bean bean-two" />
    </div>
    <section className="auth-panel">
      <div className="auth-form-wrap">
        <div className="mobile-auth-brand"><Brand /></div>
        <span className="eyebrow">OWNER WORKSPACE</span>
        <h2>{isSetup ? 'Set up your cafe' : 'Welcome back'}</h2>
        <p className="muted auth-intro">{isSetup ? 'Create your private owner login to get started. Your menu and customer list will stay empty until you add real information.' : 'Sign in to see how your cafe is bringing people back.'}</p>
        <form onSubmit={submit} className="form-stack">
          {isSetup && <label>Cafe name<input name="cafeName" value={form.cafeName} onChange={onChange} autoComplete="organization" required minLength="2" maxLength="90" placeholder="e.g. Juniper & Rye" /></label>}
          <label>Owner email<input name="ownerEmail" value={form.ownerEmail} onChange={onChange} type="email" required autoComplete={isSetup?'email':'username'} placeholder="you@yourcafe.com" /></label>
          {isSetup && <div className="form-row"><label>Currency<select name="currency" value={form.currency} onChange={onChange}><option value="INR">INR · Indian Rupee</option><option value="USD">USD · US Dollar</option><option value="GBP">GBP · British Pound</option><option value="EUR">EUR · Euro</option><option value="CAD">CAD · Canadian Dollar</option><option value="AUD">AUD · Australian Dollar</option></select></label><label>Timezone<input name="timezone" value={form.timezone} onChange={onChange} required placeholder="Asia/Kolkata" /></label></div>}
          <label>Password<div className="password-wrap"><input name="password" value={form.password} onChange={onChange} type={showPassword ? 'text' : 'password'} autoComplete={isSetup ? 'new-password' : 'current-password'} required minLength={isSetup ? 10 : 1} maxLength="128" placeholder={isSetup ? 'At least 10 characters' : 'Your password'} /><button type="button" className="text-button password-toggle" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" disabled={busy}>{busy ? <span className="loader loader-light" /> : <>{isSetup ? 'Create my workspace' : 'Sign in'} <ArrowRight size={17} /></>}</button>
        </form>
        <p className="auth-switch">{isSetup ? <>Already set up? <Link to="/owner/login">Sign in</Link></> : <>New to CafeLoop? <Link to="/owner/setup">Set up your cafe</Link></>}</p>
        <div className="auth-privacy"><span className="privacy-dot" /> Your cafe's customer data is private to your workspace.</div>
      </div>
    </section>
  </main>;
}

export function Brand({ light = false }) {
  return <Link to="/owner/dashboard" className={`brand ${light ? 'brand-light' : ''}`} aria-label="CafeLoop home"><span className="brand-mark"><Coffee size={18} strokeWidth={2.2} /></span><span>Cafe<span>Loop</span></span></Link>;
}

const navItems = [
  { to: '/owner/dashboard', label: 'Overview', icon: LayoutDashboard },
  { to: '/owner/comeback', label: 'Come back', icon: Sparkles },
  { to: '/owner/customers', label: 'Customers', icon: UsersRound },
  { to: '/owner/rewards', label: 'Rewards', icon: Gift },
  { to: '/owner/qr', label: 'Table QR', icon: QrCode },
  { to: '/owner/settings', label: 'Settings', icon: Settings2 },
];

function OwnerShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); auth.clear(); navigate('/owner/login'); };
  return <div className="owner-app">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><Brand /></div>
      <div className="cafe-mini"><span className="cafe-avatar"><Coffee size={16} /></span><span className="cafe-mini-copy"><strong>{auth.cafe?.name}</strong><small>OWNER WORKSPACE</small></span><span className="online-dot" /></div>
      <nav className="side-nav" aria-label="Owner navigation">{navItems.map(({ to, label, icon: Icon }) => <Link key={to} onClick={() => setMobileOpen(false)} className={`nav-link ${location.pathname === to ? 'nav-link-active' : ''}`} to={to}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></Link>)}</nav>
      <div className="sidebar-footer"><div className="support-note"><span className="support-icon"><CupSoda size={16} /></span><div><strong>Your cafe, your rhythm</strong><small>One good visit at a time.</small></div></div><button className="nav-link logout-link" onClick={logout}><LogOut size={18} /><span>Sign out</span></button><span className="sidebar-version">CAFELOOP · OWNER</span></div>
    </aside>
    {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="Close menu" />}
    <div className="owner-main"><header className="topbar"><button className="menu-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Open navigation"><span /><span /><span /></button><div className="topbar-cafe"><span className="topbar-cafe-dot" />{auth.cafe?.name}</div><div className="topbar-right"><span className="topbar-date">{new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric'}).format(new Date())}</span><span className="owner-avatar">{auth.owner?.email?.slice(0,1).toUpperCase()}</span></div></header><div className="page-content"><Outlet /></div></div>
    <nav className="mobile-tabbar" aria-label="Mobile owner navigation">{navItems.slice(0,5).map(({to,label,icon:Icon})=><Link key={to} to={to} className={location.pathname===to?'mobile-tab-active':''}><Icon size={19}/><small>{label}</small></Link>)}</nav>
  </div>;
}

function Landing() {
  const auth = useAuth();
  if (!auth.ready) return <div className="full-loading"><span className="loader" /></div>;
  return <Navigate to={auth.owner ? '/owner/dashboard' : '/owner/login'} replace />;
}

function App() {
  return <BrowserRouter><AuthProvider><Routes>
    <Route path="/" element={<Landing />} />
    <Route path="/order" element={<CustomerOrder />} />
    <Route path="/card" element={<CustomerCard />} />
    <Route path="/reward" element={<CustomerCard showRewards />} />
    <Route path="/owner/login" element={<AuthForm mode="login" />} />
    <Route path="/owner/setup" element={<AuthForm mode="setup" />} />
    <Route element={<Protected />}><Route path="/owner" element={<OwnerShell />}>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="comeback" element={<Comeback />} />
      <Route path="customers" element={<Customers />} />
      <Route path="rewards" element={<Rewards />} />
      <Route path="settings" element={<Settings />} />
      <Route path="qr" element={<QrPrint />} />
    </Route></Route>
    <Route path="*" element={<Landing />} />
  </Routes></AuthProvider></BrowserRouter>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
