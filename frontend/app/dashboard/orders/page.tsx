'use client';

import { useEffect, useState } from 'react';
import { useBusinessStore } from '@/store/business';
import { ordersApi } from '@/lib/api';
import ExtractionFieldsManager from '@/components/ExtractionFieldsManager';

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
  voucherImageUrl: string | null;
  voucherReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

interface PaymentLink {
  id: string;
  businessId: string;
  contactPhone: string;
  shortCode: string;
  totalAmount: number;
  currencyCode: string;
  paymentUrl: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  stripeSessionId?: string;
  items: {
    productId: string;
    productTitle: string;
    quantity: number;
    unitPrice: number;
    imageUrl?: string;
  }[];
}

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Pendiente de Pago',
  AWAITING_VOUCHER: 'Esperando Voucher',
  PAID: 'Pagado',
  PROCESSING: 'Procesando',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado'
};

const STATUS_COLORS: Record<string, string> = {
  PENDING_PAYMENT: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  AWAITING_VOUCHER: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  PAID: 'bg-green-500/20 text-green-400 border-green-500/30',
  PROCESSING: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  SHIPPED: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  DELIVERED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  CANCELLED: 'bg-red-500/20 text-red-400 border-red-500/30',
  REFUNDED: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

const LINK_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  completed: 'Completado',
  expired: 'Expirado',
  cancelled: 'Cancelado'
};

const LINK_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  completed: 'bg-green-500/20 text-green-400 border-green-500/30',
  expired: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  cancelled: 'bg-red-500/20 text-red-400 border-red-500/30'
};

export default function OrdersPage() {
  const { currentBusiness } = useBusinessStore();
  const [activeTab, setActiveTab] = useState<'orders' | 'links' | 'extraction'>('orders');
  const [orders, setOrders] = useState<Order[]>([]);
  const [paymentLinks, setPaymentLinks] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [expandedLinkId, setExpandedLinkId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [linkStatusFilter, setLinkStatusFilter] = useState<string>('');
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [confirmingPayment, setConfirmingPayment] = useState<string | null>(null);
  const [voucherModalUrl, setVoucherModalUrl] = useState<string | null>(null);

  useEffect(() => {
    if (currentBusiness?.id) {
      if (activeTab === 'orders') {
        loadOrders();
      } else {
        loadPaymentLinks();
      }
    }
  }, [currentBusiness?.id, statusFilter, linkStatusFilter, activeTab]);

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

  const loadPaymentLinks = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      const response = await ordersApi.listPaymentLinks(currentBusiness.id, linkStatusFilter || undefined);
      setPaymentLinks(response.data);
    } catch (error) {
      console.error('Error loading payment links:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (orderId: string, newStatus: string) => {
    try {
      setUpdatingStatus(orderId);
      await ordersApi.updateStatus(orderId, newStatus);
      await loadOrders();
    } catch (error) {
      console.error('Error updating order status:', error);
    } finally {
      setUpdatingStatus(null);
    }
  };

  const confirmPayment = async (orderId: string) => {
    try {
      setConfirmingPayment(orderId);
      await ordersApi.confirmPayment(orderId);
      await loadOrders();
    } catch (error) {
      console.error('Error confirming payment:', error);
    } finally {
      setConfirmingPayment(null);
    }
  };

  const toggleOrderExpand = (orderId: string) => {
    setExpandedOrderId(prev => prev === orderId ? null : orderId);
  };

  const toggleLinkExpand = (linkId: string) => {
    setExpandedLinkId(prev => prev === linkId ? null : linkId);
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

  const isExpired = (expiresAt: string) => {
    return new Date() > new Date(expiresAt);
  };

  const copyShortUrl = (shortCode: string) => {
    const url = `${window.location.origin}/pay/${shortCode}`;
    navigator.clipboard.writeText(url);
  };

  const syncPayment = async (sessionId: string) => {
    try {
      setSyncing(true);
      setSyncMessage(null);
      const response = await ordersApi.syncPayment(sessionId);
      if (response.data.success) {
        setSyncMessage('Pago sincronizado correctamente');
        await loadPaymentLinks();
        await loadOrders();
      } else {
        setSyncMessage(response.data.message || 'No se pudo sincronizar');
      }
    } catch (error: any) {
      setSyncMessage(error.response?.data?.error || 'Error al sincronizar');
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(null), 3000);
    }
  };

  if (!currentBusiness) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-gray-400">Selecciona un negocio para ver los pedidos</p>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Pedidos y Enlaces</h1>
        <p className="text-gray-400 text-sm mt-1">Gestiona pedidos y enlaces de pago</p>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4 sm:mb-6">
        <div className="flex bg-[#1e1e1e] rounded-lg p-1 border border-gray-700 overflow-x-auto">
          <button
            onClick={() => { setActiveTab('orders'); setExpandedOrderId(null); setExpandedLinkId(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'orders'
                ? 'bg-green-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Pedidos ({orders.length})
          </button>
          <button
            onClick={() => { setActiveTab('links'); setExpandedOrderId(null); setExpandedLinkId(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'links'
                ? 'bg-green-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Enlaces ({paymentLinks.length})
          </button>
          <button
            onClick={() => { setActiveTab('extraction'); setExpandedOrderId(null); setExpandedLinkId(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'extraction'
                ? 'bg-green-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Extraccion
          </button>
        </div>

        <div className="flex items-center gap-2">
          {activeTab === 'orders' && (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="flex-1 sm:flex-none bg-[#2a2a2a] border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
            >
              <option value="">Todos</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          )}
          {activeTab === 'links' && (
            <select
              value={linkStatusFilter}
              onChange={(e) => setLinkStatusFilter(e.target.value)}
              className="flex-1 sm:flex-none bg-[#2a2a2a] border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
            >
              <option value="">Todos</option>
              {Object.entries(LINK_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          )}

          {activeTab !== 'extraction' && (
            <button
              onClick={activeTab === 'orders' ? loadOrders : loadPaymentLinks}
              className="p-2 bg-[#2a2a2a] hover:bg-[#333] text-white rounded-lg transition-colors"
              title="Actualizar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {activeTab === 'extraction' ? (
        <ExtractionFieldsManager businessId={currentBusiness.id} />
      ) : loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
        </div>
      ) : activeTab === 'orders' ? (
        orders.length === 0 ? (
          <div className="text-center py-16 bg-[#1e1e1e] rounded-xl border border-gray-700">
            <div className="text-6xl mb-4">📦</div>
            <h3 className="text-xl font-semibold text-white mb-2">Sin pedidos</h3>
            <p className="text-gray-400">
              Los pedidos aparecerán aquí cuando tus clientes completen compras por WhatsApp
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {orders.map(order => {
              const isExpanded = expandedOrderId === order.id;
              return (
                <div
                  key={order.id}
                  className={`bg-[#1e1e1e] rounded-xl border transition-all ${
                    isExpanded ? 'border-green-500' : 'border-gray-700'
                  }`}
                >
                  <div
                    onClick={() => toggleOrderExpand(order.id)}
                    className="p-3 sm:p-4 cursor-pointer hover:bg-[#252525] transition-colors rounded-t-xl"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 sm:gap-3 min-w-0 flex-1">
                        <span className={`transform transition-transform mt-1 text-xs sm:text-sm ${isExpanded ? 'rotate-90' : ''}`}>
                          ▶
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                            <span className="text-white font-mono text-xs sm:text-sm">
                              #{order.id.slice(0, 8).toUpperCase()}
                            </span>
                            <span className={`px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-xs rounded-full border ${STATUS_COLORS[order.status]}`}>
                              {STATUS_LABELS[order.status]}
                            </span>
                          </div>
                          <p className="text-gray-400 text-xs sm:text-sm mt-1 truncate">
                            {order.contactName || formatPhone(order.contactPhone)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-white font-semibold text-sm sm:text-base">
                          {order.currencySymbol}{order.totalAmount.toFixed(2)}
                        </p>
                        <p className="text-gray-500 text-[10px] sm:text-xs">{formatDate(order.createdAt)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-400 mt-2 ml-5 sm:ml-7">
                      <span>{order.items.length} prod.</span>
                      {order.shippingCity && (
                        <>
                          <span>•</span>
                          <span className="truncate">{order.shippingCity}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-gray-700 p-3 sm:p-4 space-y-3 sm:space-y-4 bg-[#1a1a1a] rounded-b-xl">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                        <div>
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-1">Estado</p>
                          <select
                            value={order.status}
                            onChange={(e) => {
                              e.stopPropagation();
                              updateStatus(order.id, e.target.value);
                            }}
                            disabled={updatingStatus === order.id || order.status === 'PENDING_PAYMENT'}
                            className="w-full bg-[#2a2a2a] border border-gray-600 rounded px-2 sm:px-3 py-1.5 sm:py-2 text-white text-xs sm:text-sm focus:outline-none focus:border-green-500 disabled:opacity-50"
                          >
                            {Object.entries(STATUS_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                          {order.status === 'AWAITING_VOUCHER' && !order.voucherImageUrl && (
                            <p className="text-orange-400 text-[10px] sm:text-xs mt-1">
                              Esperando comprobante del cliente
                            </p>
                          )}
                        </div>

                        <div>
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-1">Cliente</p>
                          <p className="text-white text-sm">{order.contactName || 'Sin nombre'}</p>
                          <p className="text-gray-400 text-xs sm:text-sm">{formatPhone(order.contactPhone)}</p>
                        </div>
                      </div>

                      {order.shippingAddress && (
                        <div>
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-1">Direccion</p>
                          <p className="text-white text-xs sm:text-sm">{order.shippingAddress}</p>
                          {order.shippingCity && (
                            <p className="text-gray-400 text-xs sm:text-sm">
                              {order.shippingCity}
                              {order.shippingCountry && `, ${order.shippingCountry}`}
                            </p>
                          )}
                        </div>
                      )}

                      {order.status === 'AWAITING_VOUCHER' && (
                        <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 sm:p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1">
                              <p className="text-orange-400 font-medium text-sm mb-1">Comprobante de Pago</p>
                              {order.voucherImageUrl ? (
                                <div className="flex items-center gap-3">
                                  <img
                                    src={order.voucherImageUrl}
                                    alt="Comprobante de pago"
                                    className="w-16 h-16 sm:w-20 sm:h-20 object-cover rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setVoucherModalUrl(order.voucherImageUrl);
                                    }}
                                  />
                                  <div className="flex-1">
                                    <p className="text-green-400 text-xs sm:text-sm">Comprobante recibido</p>
                                    {order.voucherReceivedAt && (
                                      <p className="text-gray-500 text-[10px] sm:text-xs">
                                        {formatDate(order.voucherReceivedAt)}
                                      </p>
                                    )}
                                    <p className="text-gray-400 text-[10px] sm:text-xs mt-1">
                                      Click en la imagen para ampliar
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-gray-400 text-xs sm:text-sm">
                                  El cliente aun no ha enviado el comprobante de pago
                                </p>
                              )}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                confirmPayment(order.id);
                              }}
                              disabled={confirmingPayment === order.id}
                              className="px-3 sm:px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:opacity-50 text-white text-xs sm:text-sm font-medium rounded-lg transition-colors flex-shrink-0"
                            >
                              {confirmingPayment === order.id ? (
                                <span className="flex items-center gap-2">
                                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                  </svg>
                                  Confirmando...
                                </span>
                              ) : (
                                'Confirmar Pago'
                              )}
                            </button>
                          </div>
                        </div>
                      )}

                      <div>
                        <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-2">Productos</p>
                        <div className="space-y-2">
                          {order.items.map(item => (
                            <div key={item.id} className="flex items-center gap-2 sm:gap-3 bg-[#2a2a2a] rounded-lg p-2">
                              {item.imageUrl && (
                                <img
                                  src={item.imageUrl}
                                  alt={item.productTitle}
                                  className="w-8 h-8 sm:w-10 sm:h-10 object-cover rounded flex-shrink-0"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-white text-xs sm:text-sm truncate">{item.productTitle}</p>
                                <p className="text-gray-400 text-[10px] sm:text-xs">
                                  {item.quantity} x {order.currencySymbol}{item.unitPrice.toFixed(2)}
                                </p>
                              </div>
                              <p className="text-white text-xs sm:text-sm font-medium flex-shrink-0">
                                {order.currencySymbol}{(item.quantity * item.unitPrice).toFixed(2)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-3 border-t border-gray-700">
                        <div className="text-xs sm:text-sm text-gray-400">
                          {order.paidAt ? (
                            <span className="text-green-400">Pagado: {formatDate(order.paidAt)}</span>
                          ) : (
                            <span>Creado: {formatDate(order.createdAt)}</span>
                          )}
                        </div>
                        <div className="text-lg sm:text-xl font-bold text-white">
                          Total: {order.currencySymbol}{order.totalAmount.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        paymentLinks.length === 0 ? (
          <div className="text-center py-16 bg-[#1e1e1e] rounded-xl border border-gray-700">
            <div className="text-6xl mb-4">🔗</div>
            <h3 className="text-xl font-semibold text-white mb-2">Sin enlaces de pago</h3>
            <p className="text-gray-400">
              Los enlaces de pago generados aparecerán aquí
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {paymentLinks.map(link => {
              const expired = isExpired(link.expiresAt);
              const effectiveStatus = expired && link.status === 'pending' ? 'expired' : link.status;
              const isExpanded = expandedLinkId === link.id;
              
              return (
                <div
                  key={link.id}
                  className={`bg-[#1e1e1e] rounded-xl border transition-all ${
                    isExpanded ? 'border-green-500' : 'border-gray-700'
                  }`}
                >
                  <div
                    onClick={() => toggleLinkExpand(link.id)}
                    className="p-3 sm:p-4 cursor-pointer hover:bg-[#252525] transition-colors rounded-t-xl"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 sm:gap-3 min-w-0 flex-1">
                        <span className={`transform transition-transform mt-1 text-xs sm:text-sm ${isExpanded ? 'rotate-90' : ''}`}>
                          ▶
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1 sm:gap-2">
                            <span className="text-white font-mono text-xs sm:text-sm bg-[#2a2a2a] px-1.5 sm:px-2 py-0.5 sm:py-1 rounded">
                              {link.shortCode}
                            </span>
                            <span className={`px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-xs rounded-full border ${LINK_STATUS_COLORS[effectiveStatus]}`}>
                              {LINK_STATUS_LABELS[effectiveStatus]}
                            </span>
                          </div>
                          <p className="text-gray-400 text-xs sm:text-sm mt-1 truncate">
                            {formatPhone(link.contactPhone)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-white font-semibold text-sm sm:text-base">
                          {currentBusiness.currencySymbol}{link.totalAmount.toFixed(2)}
                        </p>
                        <p className="text-gray-500 text-[10px] sm:text-xs">{formatDate(link.createdAt)}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 sm:gap-2 text-xs sm:text-sm text-gray-400 mt-2 ml-5 sm:ml-7">
                      <span>{link.items.length} prod.</span>
                      <span>•</span>
                      <span className={expired ? 'text-red-400' : 'text-gray-400'}>
                        {expired ? 'Expirado' : `Exp: ${formatDate(link.expiresAt)}`}
                      </span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-gray-700 p-3 sm:p-4 space-y-3 sm:space-y-4 bg-[#1a1a1a] rounded-b-xl">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                        <div>
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-1">Codigo</p>
                          <div className="flex items-center gap-2">
                            <p className="text-white font-mono text-sm sm:text-lg">{link.shortCode}</p>
                            <button
                              onClick={(e) => { e.stopPropagation(); copyShortUrl(link.shortCode); }}
                              className="text-green-400 hover:text-green-300 text-xs sm:text-sm"
                            >
                              Copiar
                            </button>
                          </div>
                        </div>

                        <div>
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-1">Estado</p>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`px-2 sm:px-3 py-0.5 sm:py-1 text-xs sm:text-sm rounded-full border ${LINK_STATUS_COLORS[effectiveStatus]}`}>
                              {LINK_STATUS_LABELS[effectiveStatus]}
                            </span>
                            {link.status === 'pending' && link.stripeSessionId && (
                              <button
                                onClick={(e) => { e.stopPropagation(); syncPayment(link.stripeSessionId!); }}
                                disabled={syncing}
                                className="text-[10px] sm:text-xs px-2 py-1 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                              >
                                {syncing ? 'Sync...' : 'Sincronizar'}
                              </button>
                            )}
                          </div>
                          {syncMessage && (
                            <p className={`text-[10px] sm:text-xs mt-1 ${syncMessage.includes('correctamente') ? 'text-green-400' : 'text-yellow-400'}`}>
                              {syncMessage}
                            </p>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-2">Productos</p>
                        <div className="space-y-2">
                          {link.items.map((item, idx) => (
                            <div key={idx} className="flex items-center gap-2 sm:gap-3 bg-[#2a2a2a] rounded-lg p-2">
                              {item.imageUrl && (
                                <img
                                  src={item.imageUrl}
                                  alt={item.productTitle}
                                  className="w-8 h-8 sm:w-10 sm:h-10 object-cover rounded flex-shrink-0"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-white text-xs sm:text-sm truncate">{item.productTitle}</p>
                                <p className="text-gray-400 text-[10px] sm:text-xs">
                                  {item.quantity} x {currentBusiness.currencySymbol}{item.unitPrice.toFixed(2)}
                                </p>
                              </div>
                              <p className="text-white text-xs sm:text-sm font-medium flex-shrink-0">
                                {currentBusiness.currencySymbol}{(item.quantity * item.unitPrice).toFixed(2)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-3 border-t border-gray-700">
                        <div className="text-xs sm:text-sm text-gray-400">
                          <span className={expired ? 'text-red-400' : ''}>
                            Expira: {formatDate(link.expiresAt)}
                          </span>
                        </div>
                        <div className="text-lg sm:text-xl font-bold text-white">
                          Total: {currentBusiness.currencySymbol}{link.totalAmount.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {voucherModalUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setVoucherModalUrl(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh] w-full">
            <button
              onClick={() => setVoucherModalUrl(null)}
              className="absolute -top-10 right-0 text-white hover:text-gray-300 transition-colors"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <img
              src={voucherModalUrl}
              alt="Comprobante de pago"
              className="w-full h-auto max-h-[85vh] object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
            <p className="text-center text-gray-400 text-sm mt-2">
              Click fuera de la imagen para cerrar
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
