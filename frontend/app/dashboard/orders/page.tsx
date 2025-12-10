'use client';

import { useEffect, useState } from 'react';
import { useBusinessStore } from '@/store/business';
import { ordersApi } from '@/lib/api';

interface OrderItem {
  id: string;
  productId: string | null;
  productTitle: string;
  quantity: number;
  unitPrice: number;
  imageUrl: string | null;
}

interface Order {
  id: string;
  businessId: string;
  contactPhone: string;
  contactName: string | null;
  email: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  shippingCountry: string | null;
  notes: string | null;
  totalAmount: number;
  currencyCode: string;
  currencySymbol: string;
  status: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Pendiente de Pago',
  PAID: 'Pagado',
  PROCESSING: 'Procesando',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado'
};

const STATUS_COLORS: Record<string, string> = {
  PENDING_PAYMENT: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  PAID: 'bg-green-500/20 text-green-400 border-green-500/30',
  PROCESSING: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  SHIPPED: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  DELIVERED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  CANCELLED: 'bg-red-500/20 text-red-400 border-red-500/30',
  REFUNDED: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

export default function OrdersPage() {
  const { currentBusiness } = useBusinessStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);

  useEffect(() => {
    if (currentBusiness?.id) {
      loadOrders();
    }
  }, [currentBusiness?.id, statusFilter]);

  const loadOrders = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      const response = await ordersApi.list(currentBusiness.id, statusFilter || undefined);
      setOrders(response.data);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (orderId: string, newStatus: string) => {
    try {
      setUpdatingStatus(orderId);
      await ordersApi.updateStatus(orderId, newStatus);
      await loadOrders();
      if (selectedOrder?.id === orderId) {
        setSelectedOrder(prev => prev ? { ...prev, status: newStatus } : null);
      }
    } catch (error) {
      console.error('Error updating order status:', error);
    } finally {
      setUpdatingStatus(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatPhone = (phone: string) => {
    return phone.replace('@s.whatsapp.net', '').replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '+$1 $2 $3 $4');
  };

  if (!currentBusiness) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-gray-400">Selecciona un negocio para ver los pedidos</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Pedidos</h1>
          <p className="text-gray-400 mt-1">Gestiona los pedidos de tus clientes</p>
        </div>
        
        <div className="flex items-center gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-[#2a2a2a] border border-gray-600 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-green-500"
          >
            <option value="">Todos los estados</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          
          <button
            onClick={loadOrders}
            className="px-4 py-2 bg-[#2a2a2a] hover:bg-[#333] text-white rounded-lg transition-colors"
          >
            Actualizar
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 bg-[#1e1e1e] rounded-xl border border-gray-700">
          <div className="text-6xl mb-4">📦</div>
          <h3 className="text-xl font-semibold text-white mb-2">Sin pedidos</h3>
          <p className="text-gray-400">
            Los pedidos aparecerán aquí cuando tus clientes completen compras por WhatsApp
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {orders.map(order => (
              <div
                key={order.id}
                onClick={() => setSelectedOrder(order)}
                className={`bg-[#1e1e1e] rounded-xl border p-4 cursor-pointer transition-all hover:border-green-500/50 ${
                  selectedOrder?.id === order.id ? 'border-green-500' : 'border-gray-700'
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white font-mono text-sm">
                        #{order.id.slice(0, 8).toUpperCase()}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded-full border ${STATUS_COLORS[order.status]}`}>
                        {STATUS_LABELS[order.status]}
                      </span>
                    </div>
                    <p className="text-gray-400 text-sm mt-1">
                      {order.contactName || formatPhone(order.contactPhone)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-semibold">
                      {order.currencySymbol}{order.totalAmount.toFixed(2)}
                    </p>
                    <p className="text-gray-500 text-xs">{formatDate(order.createdAt)}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <span>{order.items.length} producto{order.items.length !== 1 ? 's' : ''}</span>
                  {order.shippingCity && (
                    <>
                      <span>•</span>
                      <span>{order.shippingCity}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          
          <div className="lg:col-span-1">
            {selectedOrder ? (
              <div className="bg-[#1e1e1e] rounded-xl border border-gray-700 p-4 sticky top-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-white">Detalles del Pedido</h3>
                  <button
                    onClick={() => setSelectedOrder(null)}
                    className="text-gray-400 hover:text-white"
                  >
                    ✕
                  </button>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">ID del Pedido</p>
                    <p className="text-white font-mono">{selectedOrder.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">Estado</p>
                    <select
                      value={selectedOrder.status}
                      onChange={(e) => updateStatus(selectedOrder.id, e.target.value)}
                      disabled={updatingStatus === selectedOrder.id || selectedOrder.status === 'PENDING_PAYMENT'}
                      className="w-full bg-[#2a2a2a] border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 disabled:opacity-50"
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">Cliente</p>
                    <p className="text-white">{selectedOrder.contactName || 'Sin nombre'}</p>
                    <p className="text-gray-400 text-sm">{formatPhone(selectedOrder.contactPhone)}</p>
                  </div>
                  
                  {selectedOrder.shippingAddress && (
                    <div>
                      <p className="text-gray-500 text-xs uppercase mb-1">Dirección de Envío</p>
                      <p className="text-white text-sm">{selectedOrder.shippingAddress}</p>
                      {selectedOrder.shippingCity && (
                        <p className="text-gray-400 text-sm">
                          {selectedOrder.shippingCity}
                          {selectedOrder.shippingCountry && `, ${selectedOrder.shippingCountry}`}
                        </p>
                      )}
                    </div>
                  )}
                  
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-2">Productos</p>
                    <div className="space-y-2">
                      {selectedOrder.items.map(item => (
                        <div key={item.id} className="flex items-center gap-3 bg-[#2a2a2a] rounded-lg p-2">
                          {item.imageUrl && (
                            <img
                              src={item.imageUrl}
                              alt={item.productTitle}
                              className="w-10 h-10 object-cover rounded"
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-white text-sm truncate">{item.productTitle}</p>
                            <p className="text-gray-400 text-xs">
                              {item.quantity} x {selectedOrder.currencySymbol}{item.unitPrice.toFixed(2)}
                            </p>
                          </div>
                          <p className="text-white text-sm font-medium">
                            {selectedOrder.currencySymbol}{(item.quantity * item.unitPrice).toFixed(2)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div className="border-t border-gray-700 pt-3">
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">Total</span>
                      <span className="text-white text-xl font-bold">
                        {selectedOrder.currencySymbol}{selectedOrder.totalAmount.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  
                  {selectedOrder.paidAt && (
                    <div>
                      <p className="text-gray-500 text-xs uppercase mb-1">Fecha de Pago</p>
                      <p className="text-green-400 text-sm">{formatDate(selectedOrder.paidAt)}</p>
                    </div>
                  )}
                  
                  <div>
                    <p className="text-gray-500 text-xs uppercase mb-1">Fecha de Creación</p>
                    <p className="text-gray-400 text-sm">{formatDate(selectedOrder.createdAt)}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-[#1e1e1e] rounded-xl border border-gray-700 p-8 text-center">
                <div className="text-4xl mb-3">👆</div>
                <p className="text-gray-400">Selecciona un pedido para ver sus detalles</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
