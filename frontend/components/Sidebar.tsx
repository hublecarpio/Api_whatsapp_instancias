'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { useBusinessStore } from '@/store/business';

export default function Sidebar({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { currentBusiness } = useBusinessStore();

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const links = [
    { href: '/dashboard', label: 'Dashboard', icon: '🏠' },
    { href: '/dashboard/business', label: 'Mi Empresa', icon: '🏢' },
    { href: '/dashboard/whatsapp', label: 'WhatsApp', icon: '💬' },
    { href: '/dashboard/templates', label: 'Templates', icon: '📄' },
    { href: '/dashboard/products', label: 'Productos', icon: '📦' },
    { href: '/dashboard/prompt', label: 'Agente IA', icon: '🤖' },
    { href: '/dashboard/chat', label: 'Chat', icon: '💭' },
    { href: '/dashboard/tags', label: 'Etapas', icon: '🏷️' },
    { href: '/dashboard/reminders', label: 'Seguimientos', icon: '⏰' },
    { href: '/dashboard/billing', label: 'Facturacion', icon: '💳' }
  ];

  return (
    <aside className="bg-white border-r border-gray-200 min-h-screen flex flex-col h-screen">
      <div className={`${collapsed ? 'p-2' : 'p-4'} border-b border-gray-200 flex items-center justify-between`}>
        {!collapsed && (
          <>
            <div>
              <h1 className="text-xl font-bold text-gray-900">WhatsApp SaaS</h1>
              {currentBusiness && (
                <p className="text-sm text-gray-500 mt-1 truncate">{currentBusiness.name}</p>
              )}
            </div>
          </>
        )}
        {onToggle && (
          <button
            onClick={onToggle}
            className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            title={collapsed ? 'Mostrar panel' : 'Ocultar panel'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {collapsed ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              )}
            </svg>
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto">
        {!collapsed && (
          <div className="p-4 space-y-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`sidebar-link ${pathname === link.href ? 'active' : ''}`}
              >
                <span>{link.icon}</span>
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
                className={`text-2xl hover:bg-gray-100 p-2 rounded transition-colors ${pathname === link.href ? 'bg-green-100' : ''}`}
              >
                {link.icon}
              </Link>
            ))}
          </div>
        )}
      </nav>

      {!collapsed && (
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
              <span className="text-green-600 font-medium">
                {user?.name?.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email}</p>
            </div>
          </div>
          
          {user?.subscriptionStatus && (
            <div className="mb-3">
              <Link
                href="/dashboard/billing"
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                  user.subscriptionStatus === 'active' 
                    ? 'bg-green-50 text-green-700 hover:bg-green-100'
                    : user.subscriptionStatus === 'trial'
                    ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                    : user.subscriptionStatus === 'past_due'
                    ? 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                    : 'bg-red-50 text-red-700 hover:bg-red-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${
                    user.subscriptionStatus === 'active' ? 'bg-green-500' :
                    user.subscriptionStatus === 'trial' ? 'bg-blue-500' :
                    user.subscriptionStatus === 'past_due' ? 'bg-yellow-500' : 'bg-red-500'
                  }`}></span>
                  {user.subscriptionStatus === 'active' && 'Plan Activo'}
                  {user.subscriptionStatus === 'trial' && 'Periodo de Prueba'}
                  {user.subscriptionStatus === 'past_due' && 'Pago Pendiente'}
                  {user.subscriptionStatus === 'pending' && 'Sin Suscripcion'}
                  {user.subscriptionStatus === 'canceled' && 'Cancelado'}
                </span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          )}
          
          <button
            onClick={handleLogout}
            className="btn btn-secondary w-full text-sm"
          >
            Cerrar sesion
          </button>
        </div>
      )}
    </aside>
  );
}
