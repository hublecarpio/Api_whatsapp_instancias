'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import Logo from './Logo';
import { HoloIcon } from './icons/HoloIcons';
import ContextSwitcher from './ContextSwitcher';

export default function Sidebar({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { currentBusiness } = useBusinessStore();
  
  // Subscribe to instance store - get primitive values to ensure reactivity
  const { instances, selectedInstanceId } = useInstanceStore();
  
  // Derive selected instance from primitives
  const safeInstances = Array.isArray(instances) ? instances : [];
  const selectedInstance = safeInstances.find(i => i.id === selectedInstanceId) || safeInstances[0] || null;

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  // Use selected instance's objective, fallback to business objective, then default to SALES
  const businessObjective = selectedInstance?.businessObjective || currentBusiness?.businessObjective || 'SALES';
  const instanceProvider = selectedInstance?.provider || currentBusiness?.instances?.[0]?.provider;
  
  const baseLinks = [
    { href: '/dashboard/business', label: 'Mi Empresa', icon: '🏢' },
    { href: '/dashboard/whatsapp', label: 'WhatsApp', icon: '💬' },
    { href: '/dashboard/prompt', label: 'Agente IA', icon: '🤖' },
    ...(['META_CLOUD', 'META_COEXIST'].includes(instanceProvider || '') ? [{ href: '/dashboard/templates', label: 'Templates', icon: '📄' }] : []),
  ];
  
  const salesLinks = [
    { href: '/dashboard/products', label: 'Productos', icon: '📦' },
    { href: '/dashboard/orders', label: 'Pedidos', icon: '🛒' },
  ];
  
  const appointmentLinks = [
    { href: '/dashboard/appointments', label: 'Citas', icon: '📅' },
  ];
  
  const commonLinks = [
    { href: '/dashboard/contacts', label: 'Contactos', icon: '👥' },
    { href: '/dashboard/chat', label: 'Chat', icon: '💭' },
    { href: '/dashboard/extraction', label: 'Datos Personalizados', icon: '📝' },
    { href: '/dashboard/broadcasts', label: 'Envio Masivo', icon: '📢' },
    { href: '/dashboard/tags', label: 'Etapas', icon: '🏷️' },
    { href: '/dashboard/reminders', label: 'Seguimientos', icon: '⏰' },
    { href: '/dashboard/billing', label: 'Facturacion', icon: '💳' }
  ];
  
  const links = [
    ...baseLinks,
    ...(businessObjective === 'APPOINTMENTS' ? appointmentLinks : salesLinks),
    ...commonLinks
  ];

  const getStatusInfo = () => {
    if (!user?.subscriptionStatus) return null;
    
    const planType = user.planType || 'none';
    const subscriptionTier = (user as any)?.subscriptionTier;
    const hasActiveBonus = (user as any)?.hasActiveBonus;
    
    if (planType === 'pro') {
      // Differentiate between Enterprise (bonus code) and Pro (Stripe subscription)
      // hasActiveBonus means they have an active Enterprise code (proBonusExpiresAt > now)
      if (subscriptionTier === 'ENTERPRISE' || hasActiveBonus) {
        return { label: 'Avanzado', class: 'status-pro', dotClass: 'bg-accent-purple' };
      }
      // PRO subscription via Stripe
      return { label: 'Pro', class: 'status-pro', dotClass: 'bg-accent-success' };
    }
    
    if (planType === 'basic') {
      return { label: 'Basic', class: 'status-active', dotClass: 'bg-neon-blue' };
    }
    
    const statusMap: Record<string, { label: string; class: string; dotClass: string }> = {
      active: { label: 'Plan Activo', class: 'status-active', dotClass: 'bg-accent-success' },
      trial: { label: 'Periodo de Prueba', class: 'status-trial', dotClass: 'bg-neon-blue' },
      past_due: { label: 'Pago Pendiente', class: 'status-warning', dotClass: 'bg-accent-warning' },
      pending: { label: 'Sin Suscripcion', class: 'status-error', dotClass: 'bg-accent-error' },
      canceled: { label: 'Cancelado', class: 'status-error', dotClass: 'bg-accent-error' }
    };

    return statusMap[user.subscriptionStatus] || statusMap.pending;
  };

  const statusInfo = getStatusInfo();

  return (
    <aside className="bg-dark-surface border-r border-dark-border h-screen flex flex-col sticky top-0">
      <div className={`${collapsed ? 'p-2' : 'p-4'} border-b border-dark-border flex flex-col ${collapsed ? 'items-center' : ''} relative flex-shrink-0`}>
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} w-full`}>
          {!collapsed && (
            <Logo size="md" />
          )}
          {collapsed && (
            <div className="flex flex-col items-center gap-2">
              <Logo size="sm" showText={false} />
            </div>
          )}
          {onToggle && !collapsed && (
            <button
              onClick={onToggle}
              className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
              title="Ocultar panel"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          )}
          {onToggle && collapsed && (
            <button
              onClick={onToggle}
              className="absolute right-0 top-3 p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
              title="Mostrar panel"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
        {!collapsed && (
          <a 
            href="https://hubleconsulting.com" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-[10px] text-gray-500 hover:text-gray-400 transition-colors mt-1"
          >
            by Huble Consulting LLC
          </a>
        )}
      </div>

      {!collapsed && (
        <ContextSwitcher />
      )}

      <nav className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
        {!collapsed && (
          <div className="p-4 space-y-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`sidebar-link ${pathname === link.href ? 'active' : ''}`}
              >
                <HoloIcon emoji={link.icon} size={22} />
                <span>{link.label}</span>
              </Link>
            ))}
          </div>
        )}
        {collapsed && (
          <div className="p-2 space-y-2 flex flex-col items-center">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                title={link.label}
                className={`hover:bg-dark-hover p-2 rounded-lg transition-colors ${
                  pathname === link.href ? 'bg-neon-blue/10 ring-1 ring-neon-blue/50' : ''
                }`}
              >
                <HoloIcon emoji={link.icon} size={26} />
              </Link>
            ))}
          </div>
        )}
      </nav>

      {!collapsed && (
        <div className="p-4 border-t border-dark-border flex-shrink-0 bg-dark-surface">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-neon-blue/20 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-neon-blue font-medium">
                {user?.name?.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email}</p>
            </div>
          </div>
          
          {statusInfo && (
            <div className="mb-3">
              <Link
                href="/dashboard/billing"
                className={`status-badge ${statusInfo.class} w-full justify-center hover:opacity-80 transition-opacity`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${statusInfo.dotClass}`} />
                {statusInfo.label}
              </Link>
            </div>
          )}
          
          <button
            onClick={handleLogout}
            className="btn btn-secondary w-full text-sm py-3"
          >
            Cerrar sesion
          </button>
        </div>
      )}

      {collapsed && (
        <div className="p-2 border-t border-dark-border flex-shrink-0 flex flex-col items-center gap-2">
          <div className="w-8 h-8 bg-neon-blue/20 rounded-full flex items-center justify-center">
            <span className="text-neon-blue text-sm font-medium">
              {user?.name?.charAt(0).toUpperCase()}
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="p-2 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg transition-colors"
            title="Cerrar sesion"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      )}
    </aside>
  );
}
