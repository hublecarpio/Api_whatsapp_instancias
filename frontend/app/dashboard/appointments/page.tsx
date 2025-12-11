'use client';

import { useEffect, useState } from 'react';
import { useBusinessStore } from '@/store/business';
import axios from 'axios';

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
  const [activeTab, setActiveTab] = useState<'calendar' | 'list' | 'availability'>('list');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [availability, setAvailability] = useState<BusinessAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewMonth, setViewMonth] = useState(new Date());
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showNewModal, setShowNewModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);

  const [newAppointment, setNewAppointment] = useState({
    contactPhone: '',
    contactName: '',
    scheduledAt: '',
    durationMinutes: 60,
    service: '',
    notes: ''
  });

  const [newAvailability, setNewAvailability] = useState<{ dayOfWeek: number; startTime: string; endTime: string }[]>([
    { dayOfWeek: 1, startTime: '09:00', endTime: '18:00' },
    { dayOfWeek: 2, startTime: '09:00', endTime: '18:00' },
    { dayOfWeek: 3, startTime: '09:00', endTime: '18:00' },
    { dayOfWeek: 4, startTime: '09:00', endTime: '18:00' },
    { dayOfWeek: 5, startTime: '09:00', endTime: '18:00' },
  ]);

  useEffect(() => {
    if (currentBusiness?.id) {
      loadAppointments();
      loadAvailability();
    }
  }, [currentBusiness?.id, statusFilter]);

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
      
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/appointments?${params}`,
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
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/appointments/availability/config`,
        { headers: getAuthHeader() }
      );
      setAvailability(response.data);
      
      if (response.data.length > 0) {
        const scheduleMap = response.data.reduce((acc: any, slot: BusinessAvailability) => {
          acc[slot.dayOfWeek] = { startTime: slot.startTime, endTime: slot.endTime };
          return acc;
        }, {});
        
        setNewAvailability(prev => prev.map(slot => ({
          ...slot,
          startTime: scheduleMap[slot.dayOfWeek]?.startTime || slot.startTime,
          endTime: scheduleMap[slot.dayOfWeek]?.endTime || slot.endTime
        })));
      }
    } catch (error) {
      console.error('Error loading availability:', error);
    }
  };

  const createAppointment = async () => {
    try {
      await axios.post(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/appointments`,
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
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/appointments/${id}/${endpoint}`,
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
      await axios.post(
        `${process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001'}/appointments/availability/config`,
        { schedule: newAvailability },
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
        <h1 className="text-xl sm:text-2xl font-bold text-white">Citas</h1>
        <button
          onClick={() => setShowNewModal(true)}
          className="btn btn-primary"
        >
          + Nueva Cita
        </button>
      </div>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            activeTab === 'list' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          Lista
        </button>
        <button
          onClick={() => setActiveTab('calendar')}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            activeTab === 'calendar' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          Calendario
        </button>
        <button
          onClick={() => setActiveTab('availability')}
          className={`px-4 py-2 rounded-lg text-sm transition-colors ${
            activeTab === 'availability' 
              ? 'bg-neon-blue text-white' 
              : 'bg-dark-surface text-gray-400 hover:text-white'
          }`}
        >
          Disponibilidad
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
          <div className="space-y-4">
            {newAvailability.map((slot, index) => (
              <div key={slot.dayOfWeek} className="flex items-center gap-4">
                <div className="w-24 text-gray-300">{DAY_NAMES[slot.dayOfWeek]}</div>
                <input
                  type="time"
                  value={slot.startTime}
                  onChange={(e) => {
                    const updated = [...newAvailability];
                    updated[index].startTime = e.target.value;
                    setNewAvailability(updated);
                  }}
                  className="input w-32"
                />
                <span className="text-gray-500">a</span>
                <input
                  type="time"
                  value={slot.endTime}
                  onChange={(e) => {
                    const updated = [...newAvailability];
                    updated[index].endTime = e.target.value;
                    setNewAvailability(updated);
                  }}
                  className="input w-32"
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
