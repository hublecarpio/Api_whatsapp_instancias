'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import Logo from './Logo';
import HoloIcon from './icons/HoloIcons';

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { currentBusiness } = useBusinessStore();
  
  // Subscribe to instance store - get primitive values to ensure reactivity
  const { instances, selectedInstanceId } = useInstanceStore();
  
  // Derive selected instance from primitives
  const safeInstances = Array.isArray(instances) ? instances : [];
  const selectedInstance = safeInstances.find(i => i.id === selectedInstanceId) || safeInstances[0] || null;

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleLogout = () => {
    logout();
    router.push('/login');
    onClose();
  };

  // Use selected instance's objective, fallback to business objective, then default to SALES
  const businessObjective = selectedInstance?.businessObjective || currentBusiness?.businessObjective || 'SALES';
  const instanceProvider = selectedInstance?.provider || currentBusiness?.instances?.[0]?.provider;
  
  const baseLinks = [
    { href: '/dashboard/business', label: 'Mi Empresa', icon: '🏢' },
    { href: '/dashboard/whatsapp', label: 'WhatsApp', icon: '💬' },
    ...(instanceProvider === 'META_CLOUD' ? [{ href: '/dashboard/templates', label: 'Templates', icon: '📄' }] : []),
  ];
  
  const salesLinks = [
    { href: '/dashboard/products', label: 'Productos', icon: '📦' },
    { href: '/dashboard/orders', label: 'Pedidos', icon: '🛒' },
  ];
  
  const appointmentLinks = [
    { href: '/dashboard/appointments', label: 'Citas', icon: '📅' },
    { href: '/dashboard/extraction', label: 'Datos Personalizados', icon: '📝' },
  ];
  
  const commonLinks = [
    { href: '/dashboard/contacts', label: 'Contactos', icon: '👥' },
    { href: '/dashboard/broadcasts', label: 'Envio Masivo', icon: '📢' },
    { href: '/dashboard/prompt', label: 'Agente IA', icon: '🤖' },
    { href: '/dashboard/chat', label: 'Chat', icon: '💭' },
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
    
    if (planType === 'pro') {
      return { label: 'Avanzado', class: 'status-pro', dotClass: 'bg-accent-purple' };
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
  
  const getStatusBadge = () => {
    if (!statusInfo) return null;
    return (
      <span className={`status-badge ${statusInfo.class}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${statusInfo.dotClass}`} />
        {statusInfo.label}
      </span>
    );
  };

  if (!isOpen) return null;

  return (
    <>
      <div 
        className="mobile-drawer-overlay animate-fade-in"
        onClick={onClose}
      />
      
      <aside className="mobile-drawer animate-slide-in flex flex-col">
        <div className="p-4 border-b border-dark-border flex items-center justify-between flex-shrink-0">
          <Logo size="md" />
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {currentBusiness && (
          <div className="px-4 py-3 border-b border-dark-border flex-shrink-0">
            <p className="text-sm text-gray-400">Empresa</p>
            <p className="text-white font-medium truncate">{currentBusiness.name}</p>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-thin min-h-0">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={onClose}
              className={`sidebar-link ${pathname === link.href ? 'active' : ''}`}
            >
              <HoloIcon emoji={link.icon} size={22} />
              <span>{link.label}</span>
            </Link>
          ))}
        </nav>

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
          
          <div className="mb-3">
            {getStatusBadge()}
          </div>
          
          <button
            onClick={handleLogout}
            className="btn btn-secondary w-full text-sm py-3"
          >
            Cerrar sesion
          </button>
        </div>
      </aside>
    </>
  );
}
