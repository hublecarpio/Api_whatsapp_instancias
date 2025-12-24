'use client';

import { useEffect, useState } from 'react';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import { waApi } from '@/lib/api';
import axios from 'axios';
import CustomSelect from '@/components/ui/CustomSelect';

interface Appointment {
  id: string;
  businessId: string;
  contactPhone: string;
  contactName: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  service: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

interface BusinessAvailability {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isBlocked: boolean;
  blockDate: string | null;
  blockReason: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Cancelada',
  COMPLETED: 'Completada',
  NO_SHOW: 'No asistio'
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  CONFIRMED: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  CANCELLED: 'bg-red-500/20 text-red-400 border-red-500/30',
  COMPLETED: 'bg-green-500/20 text-green-400 border-green-500/30',
  NO_SHOW: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];

export default function AppointmentsPage() {
  const { currentBusiness } = useBusinessStore();
  const { instances, setInstances, selectedInstanceId, setSelectedInstanceId } = useInstanceStore();
  const [activeTab, setActiveTab] = useState<'calendar' | 'list' | 'availability' | 'google'>('list');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [availability, setAvailability] = useState<BusinessAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewMonth, setViewMonth] = useState(new Date());
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showNewModal, setShowNewModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState<{
    configured: boolean;
    connected: boolean;
    email: string | null;
    syncEnabled: boolean;
  } | null>(null);
  const [loadingGoogle, setLoadingGoogle] = useState(false);

  const [newAppointment, setNewAppointment] = useState({
    contactPhone: '',
    contactName: '',
    scheduledAt: '',
    durationMinutes: 60,
    service: '',
    notes: ''
  });

  const [newAvailability, setNewAvailability] = useState<{ dayOfWeek: number; startTime: string; endTime: string; enabled: boolean }[]>([
    { dayOfWeek: 0, startTime: '09:00', endTime: '18:00', enabled: false },
    { dayOfWeek: 1, startTime: '09:00', endTime: '18:00', enabled: true },
    { dayOfWeek: 2, startTime: '09:00', endTime: '18:00', enabled: true },
    { dayOfWeek: 3, startTime: '09:00', endTime: '18:00', enabled: true },
    { dayOfWeek: 4, startTime: '09:00', endTime: '18:00', enabled: true },
    { dayOfWeek: 5, startTime: '09:00', endTime: '18:00', enabled: true },
    { dayOfWeek: 6, startTime: '09:00', endTime: '18:00', enabled: false },
  ]);

  useEffect(() => {
    if (currentBusiness?.id) {
      waApi.listInstances(currentBusiness.id).then((res: any) => {
        if (res.data && Array.isArray(res.data.instances)) {
          setInstances(res.data.instances);
        }
      }).catch(() => {});
      loadAppointments();
      loadAvailability();
      loadGoogleCalendarStatus();
    }
  }, [currentBusiness?.id, statusFilter]);

  useEffect(() => {
    if (currentBusiness?.id) {
      loadAppointments();
    }
  }, [selectedInstanceId]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('gcal_success') === 'true') {
      loadGoogleCalendarStatus();
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const getAuthHeader = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    return { Authorization: `Bearer ${token}` };
  };

  const loadAppointments = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (selectedInstanceId) params.set('instanceId', selectedInstanceId);
      
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/appointments?${params}`,
        { headers: getAuthHeader() }
      );
      setAppointments(response.data);
    } catch (error) {
      console.error('Error loading appointments:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAvailability = async () => {
    try {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/appointments/availability/config`,
        { headers: getAuthHeader() }
      );
      setAvailability(response.data);
      
      const scheduleMap = response.data.reduce((acc: any, slot: BusinessAvailability) => {
        acc[slot.dayOfWeek] = { startTime: slot.startTime, endTime: slot.endTime };
        return acc;
      }, {});
      
      const enabledDays = new Set(response.data.map((slot: BusinessAvailability) => slot.dayOfWeek));
      
      setNewAvailability(prev => prev.map(slot => ({
        ...slot,
        startTime: scheduleMap[slot.dayOfWeek]?.startTime || slot.startTime,
        endTime: scheduleMap[slot.dayOfWeek]?.endTime || slot.endTime,
        enabled: enabledDays.has(slot.dayOfWeek)
      })));
    } catch (error) {
      console.error('Error loading availability:', error);
    }
  };

  const loadGoogleCalendarStatus = async () => {
    try {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/google-calendar/status`,
        { headers: getAuthHeader() }
      );
      setGoogleCalendarStatus(response.data);
    } catch (error) {
      console.error('Error loading Google Calendar status:', error);
    }
  };

  const connectGoogleCalendar = async () => {
    try {
      setLoadingGoogle(true);
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/google-calendar/auth-url`,
        { headers: getAuthHeader() }
      );
      window.location.href = response.data.authUrl;
    } catch (error) {
      console.error('Error getting auth URL:', error);
      alert('Error al conectar con Google Calendar');
    } finally {
      setLoadingGoogle(false);
    }
  };

  const disconnectGoogleCalendar = async () => {
    if (!confirm('Desconectar Google Calendar? Las citas seguiran en tu calendario pero no se sincronizaran mas.')) return;
    
    try {
      setLoadingGoogle(true);
      await axios.post(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/google-calendar/disconnect`,
        {},
        { headers: getAuthHeader() }
      );
      setGoogleCalendarStatus(prev => prev ? { ...prev, connected: false, email: null } : null);
    } catch (error) {
      console.error('Error disconnecting:', error);
    } finally {
      setLoadingGoogle(false);
    }
  };

  const createAppointment = async () => {
    try {
      await axios.post(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/appointments`,
        newAppointment,
        { headers: getAuthHeader() }
      );
      setShowNewModal(false);
      setNewAppointment({
        contactPhone: '',
        contactName: '',
        scheduledAt: '',
        durationMinutes: 60,
        service: '',
        notes: ''
      });
      loadAppointments();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error al crear cita');
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      setUpdatingStatus(id);
      
      let endpoint = '';
      switch (status) {
        case 'CONFIRMED': endpoint = 'confirm'; break;
        case 'COMPLETED': endpoint = 'complete'; break;
        case 'CANCELLED': endpoint = 'cancel'; break;
        case 'NO_SHOW': endpoint = 'no-show'; break;
        default: return;
      }
      
      await axios.post(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/appointments/${id}/${endpoint}`,
        {},
        { headers: getAuthHeader() }
      );
      loadAppointments();
    } catch (error) {
      console.error('Error updating status:', error);
    } finally {
      setUpdatingStatus(null);
    }
  };

  const saveAvailability = async () => {
    try {
      const enabledSchedule = newAvailability
        .filter(slot => slot.enabled)
        .map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime }));
      
      await axios.post(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || '/api'}/appointments/availability/config`,
        { schedule: enabledSchedule },
        { headers: getAuthHeader() }
      );
      alert('Horarios guardados correctamente');
      loadAvailability();
    } catch (error) {
      console.error('Error saving availability:', error);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('es-PE', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getCalendarDays = () => {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: (Date | null)[] = [];
    
    for (let i = 0; i < firstDay.getDay(); i++) {
      days.push(null);
    }
    
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }
    
    return days;
  };

  const getAppointmentsForDate = (date: Date) => {
    return appointments.filter(apt => {
      const aptDate = new Date(apt.scheduledAt);
      return aptDate.toDateString() === date.toDateString();
    });
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl sm:text-2xl font-bold text-white">Citas</h1>
          {instances.length > 1 && (
            <CustomSelect
              value={selectedInstanceId || instances[0]?.id || ''}
              onChange={(val) => setSelectedInstanceId(val || null)}
              options={instances.map((inst: any) => ({
                  value: inst.id,
                  label: `${inst.name} ${inst.phoneNumber ? `(${inst.phoneNumber})` : ''}`
                }))}
              className="min-w-[180px]"
            />
          )}
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="btn btn-primary"
        >
          + Nueva Cita
        </button>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto pb-2 scrollbar-thin">
        <button
          onClick={() => setActiveTab('list')}
          className={`px-3 sm:px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap flex-shrink-0 ${
            activeTab === 'list' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          Lista
        </button>
        <button
          onClick={() => setActiveTab('calendar')}
          className={`px-3 sm:px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap flex-shrink-0 ${
            activeTab === 'calendar' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          Calendario
        </button>
        <button
          onClick={() => setActiveTab('availability')}
          className={`px-3 sm:px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap flex-shrink-0 ${
            activeTab === 'availability' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          Disponibilidad
        </button>
        <button
          onClick={() => setActiveTab('google')}
          className={`px-3 sm:px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-1 sm:gap-2 whitespace-nowrap flex-shrink-0 ${
            activeTab === 'google' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.46 6c-.85.38-1.78.64-2.75.76 1-.6 1.76-1.55 2.12-2.68-.93.55-1.96.95-3.06 1.17-.88-.94-2.13-1.53-3.51-1.53-2.66 0-4.81 2.16-4.81 4.81 0 .38.04.75.13 1.1-4-.2-7.58-2.11-9.96-5.02-.42.72-.66 1.56-.66 2.46 0 1.68.85 3.16 2.14 4.02-.79-.02-1.53-.24-2.18-.6v.06c0 2.35 1.67 4.31 3.88 4.76-.4.1-.83.16-1.27.16-.31 0-.62-.03-.92-.08.63 1.96 2.45 3.39 4.61 3.43-1.69 1.32-3.83 2.1-6.15 2.1-.4 0-.8-.02-1.19-.07 2.19 1.4 4.78 2.22 7.57 2.22 9.07 0 14.02-7.52 14.02-14.02 0-.21 0-.42-.01-.63.96-.69 1.79-1.56 2.45-2.55-.88.39-1.83.65-2.82.77z"/>
          </svg>
          <span className="hidden sm:inline">Google</span> Calendar
          {googleCalendarStatus?.connected && (
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
          )}
        </button>
      </div>

      {activeTab === 'list' && (
        <>
          <div className="flex gap-2 mb-4 flex-wrap">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-auto"
            >
              <option value="">Todos los estados</option>
              <option value="PENDING">Pendiente</option>
              <option value="CONFIRMED">Confirmada</option>
              <option value="COMPLETED">Completada</option>
              <option value="CANCELLED">Cancelada</option>
              <option value="NO_SHOW">No asistio</option>
            </select>
          </div>

          {loading ? (
            <div className="card">
              <div className="animate-pulse space-y-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-16 bg-dark-surface rounded" />
                ))}
              </div>
            </div>
          ) : appointments.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400 mb-4">No hay citas</p>
              <button
                onClick={() => setShowNewModal(true)}
                className="btn btn-primary"
              >
                Crear primera cita
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {appointments.map((apt) => (
                <div key={apt.id} className="card">
                  <div 
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedId(expandedId === apt.id ? null : apt.id)}
                  >
                    <div className="flex items-center gap-4">
                      <div className="text-2xl">📅</div>
                      <div>
                        <p className="text-white font-medium">{apt.contactName || apt.contactPhone}</p>
                        <p className="text-sm text-gray-400">{formatDate(apt.scheduledAt)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-1 rounded text-xs border ${STATUS_COLORS[apt.status]}`}>
                        {STATUS_LABELS[apt.status]}
                      </span>
                      <span className={`transition-transform ${expandedId === apt.id ? 'rotate-180' : ''}`}>
                        ▼
                      </span>
                    </div>
                  </div>

                  {expandedId === apt.id && (
                    <div className="mt-4 pt-4 border-t border-dark-border">
                      <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                        <div>
                          <p className="text-gray-500">Telefono</p>
                          <p className="text-white">{apt.contactPhone}</p>
                        </div>
                        <div>
                          <p className="text-gray-500">Duracion</p>
                          <p className="text-white">{apt.durationMinutes} minutos</p>
                        </div>
                        {apt.service && (
                          <div>
                            <p className="text-gray-500">Servicio</p>
                            <p className="text-white">{apt.service}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-gray-500">Creado por</p>
                          <p className="text-white">{apt.createdBy === 'agent' ? 'Agente IA' : 'Dashboard'}</p>
                        </div>
                      </div>

                      {apt.notes && (
                        <div className="mb-4">
                          <p className="text-gray-500 text-sm">Notas</p>
                          <p className="text-white text-sm">{apt.notes}</p>
                        </div>
                      )}

                      <div className="flex gap-2 flex-wrap">
                        {apt.status === 'PENDING' && (
                          <>
                            <button
                              onClick={() => updateStatus(apt.id, 'CONFIRMED')}
                              disabled={updatingStatus === apt.id}
                              className="btn btn-secondary text-sm"
                            >
                              Confirmar
                            </button>
                            <button
                              onClick={() => updateStatus(apt.id, 'CANCELLED')}
                              disabled={updatingStatus === apt.id}
                              className="btn text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30"
                            >
                              Cancelar
                            </button>
                          </>
                        )}
                        {apt.status === 'CONFIRMED' && (
                          <>
                            <button
                              onClick={() => updateStatus(apt.id, 'COMPLETED')}
                              disabled={updatingStatus === apt.id}
                              className="btn btn-primary text-sm"
                            >
                              Marcar Completada
                            </button>
                            <button
                              onClick={() => updateStatus(apt.id, 'NO_SHOW')}
                              disabled={updatingStatus === apt.id}
                              className="btn text-sm bg-gray-500/20 text-gray-400 hover:bg-gray-500/30"
                            >
                              No Asistio
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'calendar' && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1))}
              className="btn btn-secondary"
            >
              &lt;
            </button>
            <h2 className="text-lg font-semibold text-white">
              {viewMonth.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}
            </h2>
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1))}
              className="btn btn-secondary"
            >
              &gt;
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-sm mb-2">
            {['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'].map(day => (
              <div key={day} className="text-gray-500 py-2">{day}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {getCalendarDays().map((day, i) => {
              if (!day) return <div key={i} className="aspect-square" />;
              
              const dayAppointments = getAppointmentsForDate(day);
              const isToday = day.toDateString() === new Date().toDateString();
              const isSelected = day.toDateString() === selectedDate.toDateString();
              
              return (
                <div
                  key={i}
                  onClick={() => setSelectedDate(day)}
                  className={`aspect-square p-1 rounded-lg cursor-pointer transition-colors ${
                    isSelected 
                      ? 'bg-neon-blue text-white' 
                      : isToday 
                        ? 'bg-neon-blue/20 text-neon-blue' 
                        : 'hover:bg-dark-surface text-gray-300'
                  }`}
                >
                  <div className="text-sm font-medium">{day.getDate()}</div>
                  {dayAppointments.length > 0 && (
                    <div className="text-xs text-center">
                      <span className="bg-neon-blue/30 px-1 rounded">{dayAppointments.length}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 pt-4 border-t border-dark-border">
            <h3 className="text-white font-medium mb-3">
              Citas del {selectedDate.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })}
            </h3>
            {getAppointmentsForDate(selectedDate).length === 0 ? (
              <p className="text-gray-400 text-sm">No hay citas para este dia</p>
            ) : (
              <div className="space-y-2">
                {getAppointmentsForDate(selectedDate).map(apt => (
                  <div key={apt.id} className="bg-dark-surface rounded p-3 flex justify-between items-center">
                    <div>
                      <p className="text-white">{apt.contactName || apt.contactPhone}</p>
                      <p className="text-sm text-gray-400">
                        {new Date(apt.scheduledAt).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}
                        {apt.service && ` - ${apt.service}`}
                      </p>
                    </div>
                    <span className={`px-2 py-1 rounded text-xs border ${STATUS_COLORS[apt.status]}`}>
                      {STATUS_LABELS[apt.status]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'availability' && (
        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-4">Horarios de Atencion</h2>
          <p className="text-sm text-gray-400 mb-4">Configura los dias y horarios en que atiendes clientes. Los dias desactivados no estaran disponibles para agendar citas.</p>
          <div className="space-y-3">
            {newAvailability.map((slot, index) => (
              <div key={slot.dayOfWeek} className={`flex items-center gap-4 p-3 rounded-lg transition-colors ${slot.enabled ? 'bg-dark-surface' : 'bg-dark-surface/50'}`}>
                <button
                  onClick={() => {
                    const updated = [...newAvailability];
                    updated[index].enabled = !updated[index].enabled;
                    setNewAvailability(updated);
                  }}
                  className={`w-12 h-6 rounded-full relative transition-colors ${slot.enabled ? 'bg-neon-blue' : 'bg-gray-600'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${slot.enabled ? 'left-7' : 'left-1'}`} />
                </button>
                <div className={`w-24 font-medium ${slot.enabled ? 'text-white' : 'text-gray-500'}`}>
                  {DAY_NAMES[slot.dayOfWeek]}
                </div>
                <input
                  type="time"
                  value={slot.startTime}
                  disabled={!slot.enabled}
                  onChange={(e) => {
                    const updated = [...newAvailability];
                    updated[index].startTime = e.target.value;
                    setNewAvailability(updated);
                  }}
                  className={`input w-32 ${!slot.enabled && 'opacity-50 cursor-not-allowed'}`}
                />
                <span className={`${slot.enabled ? 'text-gray-400' : 'text-gray-600'}`}>a</span>
                <input
                  type="time"
                  value={slot.endTime}
                  disabled={!slot.enabled}
                  onChange={(e) => {
                    const updated = [...newAvailability];
                    updated[index].endTime = e.target.value;
                    setNewAvailability(updated);
                  }}
                  className={`input w-32 ${!slot.enabled && 'opacity-50 cursor-not-allowed'}`}
                />
              </div>
            ))}
          </div>
          <button
            onClick={saveAvailability}
            className="btn btn-primary mt-6"
          >
            Guardar Horarios
          </button>
        </div>
      )}

      {activeTab === 'google' && (
        <div className="card max-w-xl">
          <h3 className="text-lg font-semibold text-white mb-4">Integracion con Google Calendar</h3>
          
          {!googleCalendarStatus?.configured ? (
            <div className="text-center py-8">
              <div className="text-4xl mb-4">⚙️</div>
              <p className="text-gray-400 mb-2">Google Calendar no esta configurado</p>
              <p className="text-sm text-gray-500">
                Contacta al administrador para habilitar esta integracion.
              </p>
            </div>
          ) : googleCalendarStatus?.connected ? (
            <div className="space-y-6">
              <div className="flex items-center gap-4 p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
                <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                  <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-white font-medium">Conectado</p>
                  <p className="text-sm text-gray-400">{googleCalendarStatus.email}</p>
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-sm font-medium text-gray-300">Funcionalidades activas:</h4>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li className="flex items-center gap-2">
                    <span className="text-green-400">✓</span>
                    Las citas se sincronizan automaticamente con tu Google Calendar
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-green-400">✓</span>
                    Los horarios ocupados en tu calendario se respetan al consultar disponibilidad
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-green-400">✓</span>
                    El agente AI puede ver tu calendario para evitar conflictos
                  </li>
                </ul>
              </div>

              <button
                onClick={disconnectGoogleCalendar}
                disabled={loadingGoogle}
                className="btn btn-secondary w-full"
              >
                {loadingGoogle ? 'Desconectando...' : 'Desconectar Google Calendar'}
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="text-center py-4">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-dark-surface flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.5 3h-3V1.5h-1.5V3h-6V1.5H7.5V3h-3C3.675 3 3 3.675 3 4.5v15c0 .825.675 1.5 1.5 1.5h15c.825 0 1.5-.675 1.5-1.5v-15c0-.825-.675-1.5-1.5-1.5zm0 16.5h-15V9h15v10.5zm0-12h-15V4.5h15V7.5z"/>
                  </svg>
                </div>
                <p className="text-gray-400 mb-2">Conecta tu Google Calendar</p>
                <p className="text-sm text-gray-500">
                  Sincroniza tus citas automaticamente y deja que el agente AI respete tu agenda.
                </p>
              </div>

              <div className="space-y-3 text-sm text-gray-400">
                <p className="font-medium text-gray-300">Al conectar podras:</p>
                <ul className="space-y-1">
                  <li>• Ver tus citas en Google Calendar automaticamente</li>
                  <li>• Bloquear horarios ocupados de tu calendario personal</li>
                  <li>• Evitar dobles reservas con tus otros compromisos</li>
                </ul>
              </div>

              <button
                onClick={connectGoogleCalendar}
                disabled={loadingGoogle}
                className="btn btn-primary w-full flex items-center justify-center gap-2"
              >
                {loadingGoogle ? (
                  'Conectando...'
                ) : (
                  <>
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Conectar con Google
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {showNewModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card rounded-lg p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-white mb-4">Nueva Cita</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Telefono *</label>
                <input
                  type="tel"
                  value={newAppointment.contactPhone}
                  onChange={(e) => setNewAppointment({ ...newAppointment, contactPhone: e.target.value })}
                  className="input"
                  placeholder="51999888777"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Nombre</label>
                <input
                  type="text"
                  value={newAppointment.contactName}
                  onChange={(e) => setNewAppointment({ ...newAppointment, contactName: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Fecha y Hora *</label>
                <input
                  type="datetime-local"
                  value={newAppointment.scheduledAt}
                  onChange={(e) => setNewAppointment({ ...newAppointment, scheduledAt: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Duracion (minutos)</label>
                <select
                  value={newAppointment.durationMinutes}
                  onChange={(e) => setNewAppointment({ ...newAppointment, durationMinutes: parseInt(e.target.value) })}
                  className="input"
                >
                  <option value={30}>30 minutos</option>
                  <option value={60}>1 hora</option>
                  <option value={90}>1.5 horas</option>
                  <option value={120}>2 horas</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Servicio</label>
                <input
                  type="text"
                  value={newAppointment.service}
                  onChange={(e) => setNewAppointment({ ...newAppointment, service: e.target.value })}
                  className="input"
                  placeholder="Ej: Consulta, Reunion..."
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Notas</label>
                <textarea
                  value={newAppointment.notes}
                  onChange={(e) => setNewAppointment({ ...newAppointment, notes: e.target.value })}
                  className="input resize-none"
                  rows={2}
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowNewModal(false)}
                className="btn btn-secondary flex-1"
              >
                Cancelar
              </button>
              <button
                onClick={createAppointment}
                disabled={!newAppointment.contactPhone || !newAppointment.scheduledAt}
                className="btn btn-primary flex-1"
              >
                Crear Cita
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
