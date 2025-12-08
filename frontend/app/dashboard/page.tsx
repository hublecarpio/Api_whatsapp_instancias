'use client';

import { useBusinessStore } from '@/store/business';
import Link from 'next/link';

export default function DashboardPage() {
  const { currentBusiness, businesses } = useBusinessStore();

  if (!currentBusiness && businesses.length === 0) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-6">Bienvenido</h1>
        <div className="card text-center py-12">
          <p className="text-gray-400 mb-4">
            No tienes ninguna empresa configurada todavia.
          </p>
          <Link href="/dashboard/business" className="btn btn-primary">
            Crear mi empresa
          </Link>
        </div>
      </div>
    );
  }

  const instance = currentBusiness?.instances?.[0];
  const hasWhatsApp = instance && instance.status === 'open';

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-8">
        <div className="card">
          <div className="text-sm text-gray-400 mb-1">Productos</div>
          <div className="text-3xl font-bold text-white">
            {currentBusiness?._count?.products || 0}
          </div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-400 mb-1">Mensajes</div>
          <div className="text-3xl font-bold text-white">
            {currentBusiness?._count?.messages || 0}
          </div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-400 mb-1">WhatsApp</div>
          <div className={`text-lg font-bold ${hasWhatsApp ? 'text-accent-success' : 'text-accent-warning'}`}>
            {hasWhatsApp ? 'Conectado' : 'Desconectado'}
          </div>
        </div>
        <div className="card">
          <div className="text-sm text-gray-400 mb-1">Bot IA</div>
          <div className={`text-lg font-bold ${currentBusiness?.botEnabled ? 'text-accent-success' : 'text-gray-500'}`}>
            {currentBusiness?.botEnabled ? 'Activo' : 'Inactivo'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-4">Acciones rapidas</h2>
          <div className="space-y-2">
            <Link href="/dashboard/whatsapp" className="sidebar-link">
              <span>💬</span>
              <span>{hasWhatsApp ? 'Ver estado de WhatsApp' : 'Conectar WhatsApp'}</span>
            </Link>
            <Link href="/dashboard/products" className="sidebar-link">
              <span>📦</span>
              <span>Gestionar productos</span>
            </Link>
            <Link href="/dashboard/prompt" className="sidebar-link">
              <span>🤖</span>
              <span>Configurar agente IA</span>
            </Link>
            <Link href="/dashboard/chat" className="sidebar-link">
              <span>💭</span>
              <span>Ver conversaciones</span>
            </Link>
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-4">Mi empresa</h2>
          <div className="space-y-3">
            <div>
              <span className="text-sm text-gray-400">Nombre:</span>
              <p className="font-medium text-white">{currentBusiness?.name}</p>
            </div>
            {currentBusiness?.industry && (
              <div>
                <span className="text-sm text-gray-400">Industria:</span>
                <p className="font-medium text-white">{currentBusiness.industry}</p>
              </div>
            )}
            <div>
              <span className="text-sm text-gray-400">Modelo IA:</span>
              <p className="font-medium text-white">{currentBusiness?.openaiModel || 'No configurado'}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
