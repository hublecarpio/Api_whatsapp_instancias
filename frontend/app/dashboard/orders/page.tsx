'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import { useAuthStore } from '@/store/auth';
import { ordersApi, waApi, tagsApi, messageApi, deliveryZonesApi, productApi } from '@/lib/api';
import ExtractionFieldsManager from '@/components/ExtractionFieldsManager';
import CustomSelect from '@/components/ui/CustomSelect';

interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  message?: string;
  mediaUrl?: string;
  createdAt: string;
  metadata?: any;
}

interface OrderItem {
  id: string;
  productId: string | null;
  productTitle: string;
  variation?: string | null;
  quantity: number;
  unitPrice: number;
  imageUrl: string | null;
}

interface DeliveryZone {
  id: string;
  name: string;
  districts: string[];
  cost: number;
  freeAbove: number | null;
  deliveryTime: string | null;
}

interface Product {
  id: string;
  title: string;
  price: number;
  imageUrl: string | null;
}

interface PaymentRecord {
  amount: number;
  paymentMethod: string;
  operationCode: string | null;
  brand: string | null;
  imageUrl: string | null;
  notes: string | null;
  timestamp: string;
}

interface OrderNotes {
  paymentHistory?: PaymentRecord[];
  lastVoucherAmount?: number;
  lastPaymentMethod?: string;
  [key: string]: any;
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
  locationCoordinates: string | null;
  notes: string | null;
  totalAmount: number;
  subtotalAmount: number | null;
  shippingCost: number | null;
  paidAmount: number;
  pendingAmount: number | null;
  currencyCode: string;
  currencySymbol: string;
  status: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  paidAt: string | null;
  voucherImageUrl: string | null;
  voucherReceivedAt: string | null;
  promotionId: string | null;
  promotionName: string | null;
  discountType: string | null;
  discountValue: number | null;
  discountAmount: number | null;
  giftItems: string | null;
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
    variation?: string;
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

interface ExtractedDataItem {
  fieldKey: string;
  fieldLabel: string;
  value: string;
  confidence: number;
  source: string;
}

export default function OrdersPage() {
  const router = useRouter();
  const { currentBusiness } = useBusinessStore();
  const { instances, setInstances, selectedInstanceId, setSelectedInstanceId } = useInstanceStore();
  const { user } = useAuthStore();
  const canUsePaymentLinks = user?.paymentLinkEnabled ?? false;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [extractedDataCache, setExtractedDataCache] = useState<Record<string, ExtractedDataItem[]>>({});
  const [loadingExtractedData, setLoadingExtractedData] = useState<string | null>(null);
  
  // Chat embebido
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [chatPhone, setChatPhone] = useState<string | null>(null);
  const [chatContactName, setChatContactName] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Edición de productos en orden
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingItems, setEditingItems] = useState<OrderItem[]>([]);
  const [deliveryZones, setDeliveryZones] = useState<DeliveryZone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [savingItems, setSavingItems] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [showProductSelector, setShowProductSelector] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);
  const [confirmDeleteOrderId, setConfirmDeleteOrderId] = useState<string | null>(null);
  const [editingNotesOrderId, setEditingNotesOrderId] = useState<string | null>(null);
  const [editingNotesValue, setEditingNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  const deleteOrder = async (orderId: string) => {
    try {
      setDeletingOrderId(orderId);
      await ordersApi.delete(orderId);
      setConfirmDeleteOrderId(null);
      await loadOrders();
    } catch (error) {
      console.error('Error deleting order:', error);
    } finally {
      setDeletingOrderId(null);
    }
  };

  const saveOrderNotes = async (orderId: string) => {
    try {
      setSavingNotes(true);
      await ordersApi.updateNotes(orderId, editingNotesValue);
      setEditingNotesOrderId(null);
      await loadOrders();
    } catch (error) {
      console.error('Error saving notes:', error);
    } finally {
      setSavingNotes(false);
    }
  };

  const exportCSV = async () => {
    if (!currentBusiness?.id) return;
    try {
      setExporting(true);
      const response = await ordersApi.exportCSV(currentBusiness.id, statusFilter || undefined, selectedInstanceId || undefined);
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pedidos_${currentBusiness.id.substring(0, 8)}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error exporting CSV:', error);
    } finally {
      setExporting(false);
    }
  };

  const filteredOrders = orders.filter(order => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      order.contactName?.toLowerCase().includes(query) ||
      order.contactPhone.includes(query) ||
      order.id.toLowerCase().includes(query)
    );
  });

  const getMetrics = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const todayOrders = orders.filter(o => new Date(o.createdAt) >= today);
    const weekOrders = orders.filter(o => new Date(o.createdAt) >= weekAgo);
    const paidOrders = orders.filter(o => ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status));
    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.totalAmount, 0);
    const pendingCount = orders.filter(o => ['PENDING_PAYMENT', 'AWAITING_VOUCHER'].includes(o.status)).length;
    const processingCount = orders.filter(o => ['PROCESSING', 'SHIPPED'].includes(o.status)).length;

    return {
      total: orders.length,
      todayCount: todayOrders.length,
      weekCount: weekOrders.length,
      revenue: totalRevenue,
      pending: pendingCount,
      processing: processingCount,
      delivered: orders.filter(o => o.status === 'DELIVERED').length,
      currencySymbol: orders[0]?.currencySymbol || 'S/.'
    };
  };

  useEffect(() => {
    if (currentBusiness?.id) {
      waApi.listInstances(currentBusiness.id).then((res: any) => {
        if (res.data && Array.isArray(res.data.instances)) {
          setInstances(res.data.instances);
        }
      }).catch(() => {});
      if (activeTab === 'orders') {
        loadOrders();
      } else {
        loadPaymentLinks();
      }
    }
  }, [currentBusiness?.id, statusFilter, linkStatusFilter, activeTab]);

  useEffect(() => {
    if (currentBusiness?.id) {
      if (activeTab === 'orders') {
        loadOrders();
      } else if (activeTab === 'links') {
        loadPaymentLinks();
      }
    }
  }, [selectedInstanceId]);

  const loadOrders = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      const response = await ordersApi.list(currentBusiness.id, statusFilter || undefined, selectedInstanceId || undefined);
      setOrders(response.data);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadDeliveryZonesAndProducts = async () => {
    if (!currentBusiness?.id) return;
    try {
      const [zonesRes, productsRes] = await Promise.all([
        deliveryZonesApi.list(currentBusiness.id),
        productApi.list(currentBusiness.id, selectedInstanceId || undefined)
      ]);
      setDeliveryZones(zonesRes.data || []);
      setProducts(productsRes.data?.products || productsRes.data || []);
    } catch (error) {
      console.error('Error loading zones/products:', error);
    }
  };

  const startEditingOrder = (order: Order) => {
    setEditingOrderId(order.id);
    setEditingItems([...order.items]);
    loadDeliveryZonesAndProducts();
  };

  const cancelEditing = () => {
    setEditingOrderId(null);
    setEditingItems([]);
    setShowProductSelector(false);
    setProductSearch('');
  };

  const addProductToOrder = (product: Product) => {
    const existingIndex = editingItems.findIndex(i => i.productId === product.id);
    if (existingIndex >= 0) {
      const updated = [...editingItems];
      updated[existingIndex].quantity += 1;
      setEditingItems(updated);
    } else {
      setEditingItems([...editingItems, {
        id: `new-${Date.now()}`,
        productId: product.id,
        productTitle: product.title,
        quantity: 1,
        unitPrice: product.price,
        imageUrl: product.imageUrl
      }]);
    }
    setShowProductSelector(false);
    setProductSearch('');
  };

  const updateItemQuantity = (index: number, quantity: number) => {
    if (quantity <= 0) {
      setEditingItems(editingItems.filter((_, i) => i !== index));
    } else {
      const updated = [...editingItems];
      updated[index].quantity = quantity;
      setEditingItems(updated);
    }
  };

  const removeItem = (index: number) => {
    setEditingItems(editingItems.filter((_, i) => i !== index));
  };

  const getSelectedZoneCost = (order: Order): number => {
    if (selectedZoneId) {
      const zone = deliveryZones.find(z => z.id === selectedZoneId);
      if (zone) {
        const subtotal = editingItems.reduce((sum, i) => sum + (i.quantity * i.unitPrice), 0);
        if (zone.freeAbove && subtotal >= zone.freeAbove) return 0;
        return zone.cost;
      }
    }
    return order.shippingCost || 0;
  };

  const saveOrderItems = async (orderId: string, order: Order) => {
    try {
      setSavingItems(true);
      const shippingCost = getSelectedZoneCost(order);
      await ordersApi.updateItems(orderId, editingItems.map(item => ({
        productId: item.productId || undefined,
        productTitle: item.productTitle,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        imageUrl: item.imageUrl || undefined
      })), shippingCost);
      await loadOrders();
      cancelEditing();
    } catch (error) {
      console.error('Error saving order items:', error);
    } finally {
      setSavingItems(false);
    }
  };

  const filteredProducts = products.filter(p => 
    p.title.toLowerCase().includes(productSearch.toLowerCase())
  ).slice(0, 10);

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

  const toggleOrderExpand = async (orderId: string) => {
    const order = orders.find(o => o.id === orderId);
    if (expandedOrderId !== orderId && order && currentBusiness?.id) {
      if (!extractedDataCache[order.contactPhone]) {
        setLoadingExtractedData(orderId);
        try {
          const res = await tagsApi.getContactExtractedData(currentBusiness.id, order.contactPhone);
          setExtractedDataCache(prev => ({
            ...prev,
            [order.contactPhone]: res.data?.fields || []
          }));
        } catch (err) {
          console.error('Failed to load extracted data:', err);
        } finally {
          setLoadingExtractedData(null);
        }
      }
    }
    setExpandedOrderId(prev => prev === orderId ? null : orderId);
  };

  const openConversation = async (contactPhone: string, contactName?: string | null) => {
    if (!currentBusiness) return;
    setChatPhone(contactPhone);
    setChatContactName(contactName || null);
    setChatModalOpen(true);
    setChatLoading(true);
    setChatMessages([]);
    
    try {
      const response = await messageApi.conversation(currentBusiness.id, contactPhone, selectedInstanceId || undefined);
      setChatMessages(response.data || []);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('Error loading conversation:', err);
    } finally {
      setChatLoading(false);
    }
  };
  
  const openFullConversation = () => {
    if (!chatPhone) return;
    const params = new URLSearchParams({ phone: chatPhone });
    if (selectedInstanceId) {
      params.set('instance', selectedInstanceId);
    }
    router.push(`/dashboard/chat?${params.toString()}`);
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

  const getPaymentHistory = (order: Order): PaymentRecord[] => {
    if (!order.notes) return [];
    try {
      const parsed: OrderNotes = typeof order.notes === 'string' ? JSON.parse(order.notes) : order.notes;
      const history = parsed.paymentHistory || [];
      return history.filter((p: any) => 
        p && typeof p.amount === 'number' && p.timestamp
      ).map((p: any) => ({
        amount: Number(p.amount) || 0,
        paymentMethod: p.paymentMethod || 'N/A',
        operationCode: p.operationCode || null,
        brand: p.brand || null,
        imageUrl: p.imageUrl || null,
        notes: p.notes || null,
        timestamp: p.timestamp || new Date().toISOString()
      }));
    } catch {
      return [];
    }
  };

  const getPaymentProgress = (order: Order) => {
    const paid = Number(order.paidAmount) || 0;
    const total = Number(order.totalAmount) || 0;
    const pending = order.pendingAmount != null ? Number(order.pendingAmount) : (total - paid);
    const percentage = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
    return { paid, total, pending, percentage, isFullyPaid: paid >= total };
  };

  const getInternalNotes = (order: Order): string => {
    if (!order.notes) return '';
    try {
      const parsed = typeof order.notes === 'string' ? JSON.parse(order.notes) : order.notes;
      return parsed.internalNotes || parsed.originalNote || '';
    } catch {
      return typeof order.notes === 'string' ? order.notes : '';
    }
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
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-bold text-white">
            {canUsePaymentLinks ? 'Pedidos y Enlaces' : 'Pedidos y Vouchers'}
          </h1>
          {instances.length > 1 && (
            <CustomSelect
              value={selectedInstanceId || ''}
              onChange={(val) => setSelectedInstanceId(val || null)}
              options={[
                { value: '', label: 'Todas las instancias' },
                ...instances.map((inst: any) => ({
                  value: inst.id,
                  label: `${inst.name} ${inst.phoneNumber ? `(${inst.phoneNumber})` : ''}`
                }))
              ]}
              className="min-w-[180px]"
            />
          )}
        </div>
        <p className="text-gray-400 text-sm mt-1">
          {canUsePaymentLinks ? 'Gestiona pedidos y enlaces de pago' : 'Gestiona pedidos y confirma pagos con voucher'}
        </p>
      </div>

      {(() => {
        const metrics = getMetrics();
        const awaitingVoucher = orders.filter(o => o.status === 'AWAITING_VOUCHER');
        const withVoucher = awaitingVoucher.filter(o => o.voucherImageUrl);
        return (
          <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <div className="bg-neon-blue/10 border border-neon-blue/30 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Total Pedidos</p>
              <p className="text-2xl font-bold text-white">{metrics.total}</p>
            </div>
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Ingresos</p>
              <p className="text-xl font-bold text-green-400">{metrics.currencySymbol}{metrics.revenue.toFixed(0)}</p>
            </div>
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Hoy</p>
              <p className="text-2xl font-bold text-yellow-400">{metrics.todayCount}</p>
            </div>
            <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Semana</p>
              <p className="text-2xl font-bold text-purple-400">{metrics.weekCount}</p>
            </div>
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
              <p className="text-gray-400 text-xs">En Proceso</p>
              <p className="text-2xl font-bold text-blue-400">{metrics.processing}</p>
            </div>
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
              <p className="text-gray-400 text-xs">Entregados</p>
              <p className="text-2xl font-bold text-emerald-400">{metrics.delivered}</p>
            </div>
            {!canUsePaymentLinks && withVoucher.length > 0 && (
              <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 col-span-2">
                <p className="text-gray-400 text-xs">Vouchers por Confirmar</p>
                <p className="text-2xl font-bold text-orange-400">{withVoucher.length}</p>
              </div>
            )}
          </div>
        );
      })()}

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
          {canUsePaymentLinks && (
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
          )}
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

        <div className="flex items-center gap-2 flex-1">
          {activeTab === 'orders' && (
            <>
              <input
                type="text"
                placeholder="Buscar por nombre o telefono..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 sm:w-64 bg-[#2a2a2a] border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-[#2a2a2a] border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
              >
                <option value="">Todos</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </>
          )}
          {canUsePaymentLinks && activeTab === 'links' && (
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
            <div className="flex items-center gap-2">
              {activeTab === 'orders' && (
                <button
                  onClick={exportCSV}
                  disabled={exporting || orders.length === 0}
                  className="px-3 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs sm:text-sm rounded-lg transition-colors flex items-center gap-1.5"
                  title="Exportar a CSV"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {exporting ? 'Exportando...' : 'CSV'}
                </button>
              )}
              <button
                onClick={activeTab === 'orders' ? loadOrders : loadPaymentLinks}
                className="p-2 bg-[#2a2a2a] hover:bg-[#333] text-white rounded-lg transition-colors"
                title="Actualizar"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
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
            {filteredOrders.map(order => {
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openConversation(order.contactPhone, order.contactName);
                            }}
                            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 hover:bg-green-600/30 text-green-400 text-xs rounded-lg transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            Ver Conversacion
                          </button>
                        </div>
                      </div>

                      {extractedDataCache[order.contactPhone]?.length > 0 && (
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 sm:p-4">
                          <p className="text-blue-400 font-medium text-sm mb-2">Datos del Cliente</p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {extractedDataCache[order.contactPhone].map((field) => (
                              <div key={field.fieldKey} className="bg-[#1a1a1a] rounded px-2 py-1.5">
                                <p className="text-gray-500 text-[10px] uppercase">{field.fieldLabel}</p>
                                <p className="text-white text-xs sm:text-sm truncate">{field.value}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {loadingExtractedData === order.id && (
                        <div className="flex items-center gap-2 text-gray-400 text-xs">
                          <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></div>
                          Cargando datos del cliente...
                        </div>
                      )}

                      {(order.shippingAddress || order.locationCoordinates) && (
                        <div>
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase mb-1">Direccion</p>
                          {order.shippingAddress && (
                            <p className="text-white text-xs sm:text-sm">{order.shippingAddress}</p>
                          )}
                          {order.shippingCity && (
                            <p className="text-gray-400 text-xs sm:text-sm">
                              {order.shippingCity}
                              {order.shippingCountry && `, ${order.shippingCountry}`}
                            </p>
                          )}
                          {order.locationCoordinates && (
                            <a
                              href={`https://www.google.com/maps?q=${order.locationCoordinates}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-xs rounded-lg transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                              </svg>
                              Ver en Google Maps
                            </a>
                          )}
                        </div>
                      )}

                      {/* Seccion de Notas Internas */}
                      <div className="bg-[#1a1a1a]/50 rounded-lg p-2">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-gray-500 text-[10px] uppercase">Notas Internas</p>
                          {editingNotesOrderId !== order.id && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingNotesOrderId(order.id);
                                setEditingNotesValue(getInternalNotes(order));
                              }}
                              className="text-gray-500 hover:text-gray-300 transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                          )}
                        </div>
                        {editingNotesOrderId === order.id ? (
                          <div className="space-y-1.5">
                            <textarea
                              value={editingNotesValue}
                              onChange={(e) => setEditingNotesValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="Agregar nota interna..."
                              className="w-full bg-[#0a0a0a] text-white text-xs rounded px-2 py-1.5 resize-none border border-gray-700 focus:border-gray-500 focus:outline-none"
                              rows={2}
                            />
                            <div className="flex gap-1.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  saveOrderNotes(order.id);
                                }}
                                disabled={savingNotes}
                                className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-700 disabled:bg-green-800 text-white text-[10px] rounded transition-colors"
                              >
                                {savingNotes ? 'Guardando...' : 'Guardar'}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingNotesOrderId(null);
                                }}
                                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white text-[10px] rounded transition-colors"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-gray-400 text-xs italic">
                            {getInternalNotes(order) || 'Sin notas'}
                          </p>
                        )}
                      </div>

                      {/* Seccion de Estado de Pagos - Siempre visible */}
                      {(() => {
                        const progress = getPaymentProgress(order);
                        const paymentHistory = getPaymentHistory(order);
                        const hasPayments = paymentHistory.length > 0 || progress.paid > 0;
                        
                        return (
                          <div className={`rounded-lg p-2.5 ${
                            progress.isFullyPaid 
                              ? 'bg-green-500/10 border border-green-500/30' 
                              : progress.paid > 0 
                                ? 'bg-yellow-500/10 border border-yellow-500/30'
                                : 'bg-orange-500/10 border border-orange-500/30'
                          }`}>
                            {/* Header con estado y barra en una fila */}
                            <div className="flex items-center gap-3 mb-1.5">
                              <span className={`text-xs font-medium whitespace-nowrap ${
                                progress.isFullyPaid ? 'text-green-400' : progress.paid > 0 ? 'text-yellow-400' : 'text-orange-400'
                              }`}>
                                {progress.isFullyPaid ? '✓ Pagado' : progress.paid > 0 ? '◐ Parcial' : '○ Pendiente'}
                              </span>
                              <div className="flex-1">
                                <div className="w-full bg-gray-700 rounded-full h-1.5">
                                  <div 
                                    className={`h-1.5 rounded-full transition-all ${progress.isFullyPaid ? 'bg-green-500' : 'bg-yellow-500'}`}
                                    style={{ width: `${progress.percentage}%` }}
                                  ></div>
                                </div>
                              </div>
                              <span className="text-[10px] text-gray-400 whitespace-nowrap">
                                {order.currencySymbol || '$'}{progress.paid.toFixed(2)} / {order.currencySymbol || '$'}{progress.total.toFixed(2)}
                                {!progress.isFullyPaid && progress.pending > 0 && (
                                  <span className="text-orange-400 ml-1">(−{progress.pending.toFixed(2)})</span>
                                )}
                              </span>
                            </div>
                            
                            {/* Historial de pagos compacto */}
                            {paymentHistory.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {paymentHistory.map((payment, idx) => (
                                  <div key={idx} className="flex items-center gap-1.5 bg-[#1a1a1a] rounded px-2 py-1">
                                    {payment.imageUrl && (
                                      <img
                                        src={payment.imageUrl}
                                        alt={`V${idx + 1}`}
                                        className="w-6 h-6 object-cover rounded cursor-pointer hover:opacity-80"
                                        onClick={(e) => { e.stopPropagation(); setVoucherModalUrl(payment.imageUrl); }}
                                      />
                                    )}
                                    <span className="text-white text-xs font-medium">{order.currencySymbol || '$'}{payment.amount.toFixed(2)}</span>
                                    <span className="text-[10px] text-gray-500">{payment.paymentMethod}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            
                            {/* Voucher único compacto */}
                            {paymentHistory.length === 0 && order.voucherImageUrl && (
                              <div className="flex items-center gap-2 mt-1.5">
                                <img
                                  src={order.voucherImageUrl}
                                  alt="Comprobante"
                                  className="w-10 h-10 object-cover rounded cursor-pointer hover:opacity-80"
                                  onClick={(e) => { e.stopPropagation(); setVoucherModalUrl(order.voucherImageUrl); }}
                                />
                                <span className="text-green-400 text-xs">Comprobante recibido</span>
                                {order.voucherReceivedAt && (
                                  <span className="text-gray-500 text-[10px]">{formatDate(order.voucherReceivedAt)}</span>
                                )}
                              </div>
                            )}
                            
                            {/* Sin pagos aun */}
                            {!hasPayments && !order.voucherImageUrl && (
                              <p className="text-gray-400 text-xs sm:text-sm">
                                El cliente aun no ha enviado comprobante de pago
                              </p>
                            )}
                            
                            {/* Boton confirmar pago manual - solo para AWAITING_VOUCHER */}
                            {order.status === 'AWAITING_VOUCHER' && (
                              <div className="mt-3 pt-3 border-t border-gray-600/50">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    confirmPayment(order.id);
                                  }}
                                  disabled={confirmingPayment === order.id}
                                  className="w-full px-3 sm:px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:opacity-50 text-white text-xs sm:text-sm font-medium rounded-lg transition-colors"
                                >
                                  {confirmingPayment === order.id ? (
                                    <span className="flex items-center justify-center gap-2">
                                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                      </svg>
                                      Confirmando...
                                    </span>
                                  ) : (
                                    'Confirmar Pago Manualmente'
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-gray-500 text-[10px] sm:text-xs uppercase">Productos</p>
                          {editingOrderId !== order.id && !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(order.status) && (
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditingOrder(order); }}
                              className="text-neon-blue text-xs hover:underline"
                            >
                              Editar
                            </button>
                          )}
                        </div>
                        
                        {editingOrderId === order.id ? (
                          <div className="space-y-3">
                            <div className="space-y-2">
                              {editingItems.map((item, index) => (
                                <div key={item.id} className="flex items-center gap-2 bg-[#2a2a2a] rounded-lg p-2">
                                  {item.imageUrl && (
                                    <img src={item.imageUrl} alt={item.productTitle} className="w-8 h-8 object-cover rounded flex-shrink-0" />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <p className="text-white text-xs truncate">{item.productTitle}{item.variation && <span className="text-gray-400"> ({item.variation})</span>}</p>
                                    <p className="text-gray-400 text-[10px]">{order.currencySymbol}{item.unitPrice.toFixed(2)}</p>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <button onClick={(e) => { e.stopPropagation(); updateItemQuantity(index, item.quantity - 1); }} className="w-6 h-6 bg-gray-700 rounded text-white text-sm">-</button>
                                    <span className="text-white text-xs w-6 text-center">{item.quantity}</span>
                                    <button onClick={(e) => { e.stopPropagation(); updateItemQuantity(index, item.quantity + 1); }} className="w-6 h-6 bg-gray-700 rounded text-white text-sm">+</button>
                                  </div>
                                  <button onClick={(e) => { e.stopPropagation(); removeItem(index); }} className="text-red-400 hover:text-red-300 text-xs ml-2">✕</button>
                                </div>
                              ))}
                            </div>
                            
                            <div className="relative">
                              <button
                                onClick={(e) => { e.stopPropagation(); setShowProductSelector(!showProductSelector); }}
                                className="w-full py-2 border border-dashed border-gray-600 rounded-lg text-gray-400 text-xs hover:border-neon-blue hover:text-neon-blue transition-colors"
                              >
                                + Agregar Producto
                              </button>
                              {showProductSelector && (
                                <div className="absolute top-full left-0 right-0 mt-1 bg-dark-surface border border-dark-border rounded-lg shadow-xl z-30 max-h-48 overflow-auto" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="text"
                                    value={productSearch}
                                    onChange={(e) => setProductSearch(e.target.value)}
                                    placeholder="Buscar producto..."
                                    className="w-full px-3 py-2 bg-dark-card border-b border-dark-border text-white text-sm outline-none"
                                    autoFocus
                                  />
                                  {filteredProducts.map(product => (
                                    <button
                                      key={product.id}
                                      onClick={(e) => { e.stopPropagation(); addProductToOrder(product); }}
                                      className="w-full px-3 py-2 text-left hover:bg-dark-card flex items-center gap-2"
                                    >
                                      {product.imageUrl && <img src={product.imageUrl} alt="" className="w-6 h-6 object-cover rounded" />}
                                      <span className="text-white text-sm flex-1 truncate">{product.title}</span>
                                      <span className="text-gray-400 text-xs">{order.currencySymbol}{product.price.toFixed(2)}</span>
                                    </button>
                                  ))}
                                  {filteredProducts.length === 0 && <p className="px-3 py-2 text-gray-500 text-xs">No hay productos</p>}
                                </div>
                              )}
                            </div>

                            {deliveryZones.length > 0 && (
                              <div className="bg-[#2a2a2a] rounded-lg p-3">
                                <p className="text-gray-400 text-xs mb-2">Zona de Envío</p>
                                <select
                                  value={selectedZoneId || ''}
                                  onChange={(e) => setSelectedZoneId(e.target.value || null)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-full bg-dark-card border border-dark-border rounded px-2 py-1 text-white text-sm"
                                >
                                  <option value="">Sin cambio ({order.currencySymbol}{(order.shippingCost || 0).toFixed(2)})</option>
                                  {deliveryZones.map(zone => (
                                    <option key={zone.id} value={zone.id}>
                                      {zone.name} - {order.currencySymbol}{zone.cost.toFixed(2)}
                                      {zone.freeAbove ? ` (Gratis +${order.currencySymbol}${zone.freeAbove})` : ''}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}

                            <div className="flex items-center justify-between text-sm pt-2 border-t border-gray-700">
                              <span className="text-gray-400">Subtotal:</span>
                              <span className="text-white">{order.currencySymbol}{editingItems.reduce((sum, i) => sum + (i.quantity * i.unitPrice), 0).toFixed(2)}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-400">Envío:</span>
                              <span className="text-white">{order.currencySymbol}{getSelectedZoneCost(order).toFixed(2)}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm font-bold">
                              <span className="text-white">Nuevo Total:</span>
                              <span className="text-neon-blue">{order.currencySymbol}{(editingItems.reduce((sum, i) => sum + (i.quantity * i.unitPrice), 0) + getSelectedZoneCost(order)).toFixed(2)}</span>
                            </div>

                            <div className="flex gap-2 pt-2">
                              <button onClick={(e) => { e.stopPropagation(); cancelEditing(); }} className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg">Cancelar</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); saveOrderItems(order.id, order); }}
                                disabled={savingItems || editingItems.length === 0}
                                className="flex-1 py-2 bg-neon-blue hover:bg-neon-blue/80 disabled:opacity-50 text-white text-xs rounded-lg"
                              >
                                {savingItems ? 'Guardando...' : 'Guardar Cambios'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {order.items.map(item => (
                              <div key={item.id} className="flex items-center gap-2 sm:gap-3 bg-[#2a2a2a] rounded-lg p-2">
                                {item.imageUrl && (
                                  <img src={item.imageUrl} alt={item.productTitle} className="w-8 h-8 sm:w-10 sm:h-10 object-cover rounded flex-shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <p className="text-white text-xs sm:text-sm truncate">{item.productTitle}{item.variation && <span className="text-gray-400"> ({item.variation})</span>}</p>
                                  <p className="text-gray-400 text-[10px] sm:text-xs">{item.quantity} x {order.currencySymbol}{item.unitPrice.toFixed(2)}</p>
                                </div>
                                <p className="text-white text-xs sm:text-sm font-medium flex-shrink-0">{order.currencySymbol}{(item.quantity * item.unitPrice).toFixed(2)}</p>
                              </div>
                            ))}
                            {(order.shippingCost ?? 0) > 0 && (
                              <div className="flex items-center justify-between text-xs text-gray-400 pt-2 border-t border-gray-700/50">
                                <span>Envío:</span>
                                <span>{order.currencySymbol}{(order.shippingCost || 0).toFixed(2)}</span>
                              </div>
                            )}
                            {order.promotionName && (
                              <div className="mt-3 p-2 bg-purple-500/10 border border-purple-500/30 rounded-lg">
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="text-purple-400 font-medium">🎁 {order.promotionName}</span>
                                  {order.discountAmount && order.discountAmount > 0 && (
                                    <span className="text-green-400">
                                      -{order.currencySymbol}{order.discountAmount.toFixed(2)}
                                      {order.discountType === 'PERCENTAGE' && order.discountValue && ` (${order.discountValue}%)`}
                                    </span>
                                  )}
                                </div>
                                {order.giftItems && (
                                  <p className="text-xs text-gray-400 mt-1">Regalo: {order.giftItems}</p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {(order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'SHIPPED') && (
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 sm:p-4">
                          <p className="text-blue-400 font-medium text-sm mb-3">Acciones Rapidas</p>
                          <div className="flex flex-wrap gap-2">
                            {order.status === 'PAID' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateStatus(order.id, 'PROCESSING');
                                }}
                                disabled={updatingStatus === order.id}
                                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm rounded-lg transition-colors"
                              >
                                Iniciar Preparacion
                              </button>
                            )}
                            {order.status === 'PROCESSING' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateStatus(order.id, 'SHIPPED');
                                }}
                                disabled={updatingStatus === order.id}
                                className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm rounded-lg transition-colors"
                              >
                                Marcar En Camino
                              </button>
                            )}
                            {order.status === 'SHIPPED' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateStatus(order.id, 'DELIVERED');
                                }}
                                disabled={updatingStatus === order.id}
                                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm rounded-lg transition-colors"
                              >
                                Marcar Entregado
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-3 border-t border-gray-700">
                        <div className="text-xs sm:text-sm text-gray-400">
                          {order.paidAt ? (
                            <span className="text-green-400">Pagado: {formatDate(order.paidAt)}</span>
                          ) : (
                            <span>Creado: {formatDate(order.createdAt)}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteOrderId(order.id);
                            }}
                            className="px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/30 rounded text-xs transition-colors"
                          >
                            Eliminar
                          </button>
                          <div className="text-lg sm:text-xl font-bold text-white">
                            Total: {order.currencySymbol}{order.totalAmount.toFixed(2)}
                          </div>
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
                                <p className="text-white text-xs sm:text-sm truncate">{item.productTitle}{item.variation && <span className="text-gray-400"> ({item.variation})</span>}</p>
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

      {/* Modal de Chat Embebido */}
      {chatModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#1a1a1a] rounded-xl w-full max-w-lg h-[80vh] max-h-[600px] flex flex-col shadow-2xl border border-gray-700">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center text-white font-bold">
                  {(chatContactName || chatPhone || 'U')[0].toUpperCase()}
                </div>
                <div>
                  <p className="text-white font-medium">{chatContactName || 'Cliente'}</p>
                  <p className="text-gray-400 text-sm">{chatPhone ? `+${chatPhone.replace(/^51/, '51 ')}` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={openFullConversation}
                  className="p-2 hover:bg-gray-700 rounded-lg transition-colors text-gray-400 hover:text-white"
                  title="Abrir chat completo"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </button>
                <button
                  onClick={() => setChatModalOpen(false)}
                  className="p-2 hover:bg-gray-700 rounded-lg transition-colors text-gray-400 hover:text-white"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatLoading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500"></div>
                </div>
              ) : chatMessages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  <p>No hay mensajes en esta conversacion</p>
                </div>
              ) : (
                chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-3 py-2 ${
                        msg.direction === 'outbound'
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-white'
                      }`}
                    >
                      {msg.mediaUrl && (
                        <img
                          src={msg.mediaUrl}
                          alt="Media"
                          className="max-w-full rounded mb-2 max-h-48 object-contain"
                        />
                      )}
                      {msg.message && (
                        <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>
                      )}
                      <p className={`text-[10px] mt-1 ${msg.direction === 'outbound' ? 'text-green-200' : 'text-gray-400'}`}>
                        {new Date(msg.createdAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-700">
              <button
                onClick={openFullConversation}
                className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                Abrir conversacion completa
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteOrderId && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1e1e1e] rounded-xl border border-gray-700 max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-white mb-4">Eliminar Pedido</h3>
            <p className="text-gray-300 mb-6">
              ¿Estás seguro de que deseas eliminar este pedido? Esta acción no se puede deshacer.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteOrderId(null)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => deleteOrder(confirmDeleteOrderId)}
                disabled={deletingOrderId === confirmDeleteOrderId}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {deletingOrderId === confirmDeleteOrderId ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
