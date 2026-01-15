'use client';

import { useState, useEffect, useRef } from 'react';
import { deliveryZonesApi } from '@/lib/api';

interface DeliveryZone {
  id: string;
  name: string;
  districts: string[];
  address: string | null;
  cost: number;
  freeAbove: number | null;
  deliveryTime: string | null;
  policy: string | null;
  isActive: boolean;
  order: number;
}

interface DeliveryZonesProps {
  businessId: string;
  currencySymbol?: string;
}

export default function DeliveryZones({ businessId, currencySymbol = 'S/.' }: DeliveryZonesProps) {
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingZone, setEditingZone] = useState<DeliveryZone | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importData, setImportData] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [form, setForm] = useState({
    name: '',
    districts: '',
    address: '',
    cost: '',
    freeAbove: '',
    deliveryTime: '',
    policy: ''
  });

  useEffect(() => {
    loadZones();
  }, [businessId]);

  const loadZones = async () => {
    try {
      setLoading(true);
      const response = await deliveryZonesApi.list(businessId);
      setZones(response.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error loading zones');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.cost) {
      setError('Nombre y costo son requeridos');
      return;
    }
    
    try {
      setSaving(true);
      setError('');
      
      const data = {
        name: form.name,
        districts: form.districts.split(',').map(d => d.trim()).filter(Boolean),
        address: form.address || undefined,
        cost: parseFloat(form.cost),
        freeAbove: form.freeAbove ? parseFloat(form.freeAbove) : undefined,
        deliveryTime: form.deliveryTime || undefined,
        policy: form.policy || undefined
      };
      
      if (editingZone) {
        await deliveryZonesApi.update(businessId, editingZone.id, data);
        setSuccess('Zona actualizada');
      } else {
        await deliveryZonesApi.create(businessId, data);
        setSuccess('Zona creada');
      }
      
      resetForm();
      loadZones();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error saving zone');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (zone: DeliveryZone) => {
    setEditingZone(zone);
    setForm({
      name: zone.name,
      districts: zone.districts.join(', '),
      address: zone.address || '',
      cost: zone.cost.toString(),
      freeAbove: zone.freeAbove?.toString() || '',
      deliveryTime: zone.deliveryTime || '',
      policy: zone.policy || ''
    });
    setShowForm(true);
  };

  const handleDelete = async (zoneId: string) => {
    if (!confirm('¿Eliminar esta zona de envío?')) return;
    
    try {
      await deliveryZonesApi.delete(businessId, zoneId);
      setSuccess('Zona eliminada');
      loadZones();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error deleting zone');
    }
  };

  const handleToggleActive = async (zone: DeliveryZone) => {
    try {
      await deliveryZonesApi.update(businessId, zone.id, { isActive: !zone.isActive });
      loadZones();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error updating zone');
    }
  };

  const resetForm = () => {
    setForm({ name: '', districts: '', address: '', cost: '', freeAbove: '', deliveryTime: '', policy: '' });
    setEditingZone(null);
    setShowForm(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setImportData(text);
    };
    reader.readAsText(file);
  };

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const parseCSV = (csvText: string): any[] => {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];
    
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
    const zones: any[] = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const zone: any = {};
      
      headers.forEach((header, index) => {
        if (header === 'name' || header === 'nombre') zone.name = values[index];
        if (header === 'districts' || header === 'distritos') zone.districts = values[index];
        if (header === 'address' || header === 'direccion') zone.address = values[index];
        if (header === 'cost' || header === 'costo') zone.cost = values[index];
        if (header === 'freeabove' || header === 'gratisdesde') zone.freeAbove = values[index];
        if (header === 'deliverytime' || header === 'tiempoentrega') zone.deliveryTime = values[index];
        if (header === 'policy' || header === 'politica') zone.policy = values[index];
      });
      
      if (zone.name) zones.push(zone);
    }
    
    return zones;
  };

  const handleImport = async () => {
    if (!importData.trim()) {
      setError('No hay datos para importar');
      return;
    }
    
    try {
      setImporting(true);
      setError('');
      
      const zonesToImport = parseCSV(importData);
      if (zonesToImport.length === 0) {
        setError('No se encontraron zonas válidas en el archivo');
        return;
      }
      
      const response = await deliveryZonesApi.import(businessId, zonesToImport);
      setSuccess(`Importadas ${response.data.imported} zonas${response.data.errors > 0 ? `, ${response.data.errors} errores` : ''}`);
      setShowImportModal(false);
      setImportData('');
      loadZones();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error importing zones');
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (success || error) {
      const timer = setTimeout(() => {
        setSuccess('');
        setError('');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [success, error]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-neon-blue"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Zonas de Envío</h3>
          <p className="text-sm text-gray-400">
            Define las zonas de cobertura, costos de envío y tiempos de entrega. El agente usará esta información para responder consultas sobre envíos.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowImportModal(true)}
            className="px-4 py-2 bg-dark-card text-gray-300 rounded-lg hover:bg-dark-hover transition-colors text-sm"
          >
            Importar CSV
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg hover:bg-neon-blue/80 transition-colors text-sm font-medium"
          >
            + Agregar Zona
          </button>
        </div>
      </div>

      {(error || success) && (
        <div className={`p-3 rounded-lg ${error ? 'bg-accent-error/20 text-accent-error' : 'bg-accent-success/20 text-accent-success'}`}>
          {error || success}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-dark-card border border-dark-border rounded-lg p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h4 className="font-medium text-white">{editingZone ? 'Editar Zona' : 'Nueva Zona'}</h4>
            <button type="button" onClick={resetForm} className="text-gray-400 hover:text-white">✕</button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Nombre de la Zona *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ej: Lima Centro, Zona Norte..."
                className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Costo de Envío ({currencySymbol}) *</label>
              <input
                type="number"
                step="0.01"
                value={form.cost}
                onChange={(e) => setForm({ ...form, cost: e.target.value })}
                placeholder="Ej: 10.00"
                className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Distritos (separados por coma)</label>
              <input
                type="text"
                value={form.districts}
                onChange={(e) => setForm({ ...form, districts: e.target.value })}
                placeholder="Ej: Miraflores, San Isidro, Barranco..."
                className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Gratis en compras mayores a ({currencySymbol})</label>
              <input
                type="number"
                step="0.01"
                value={form.freeAbove}
                onChange={(e) => setForm({ ...form, freeAbove: e.target.value })}
                placeholder="Ej: 100.00 (dejar vacío si no aplica)"
                className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Tiempo de Entrega</label>
              <input
                type="text"
                value={form.deliveryTime}
                onChange={(e) => setForm({ ...form, deliveryTime: e.target.value })}
                placeholder="Ej: 1-2 días hábiles"
                className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Dirección de Recojo (opcional)</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="Si aplica, dirección para recojo"
                className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Política de Envío (opcional)</label>
            <textarea
              value={form.policy}
              onChange={(e) => setForm({ ...form, policy: e.target.value })}
              placeholder="Detalles adicionales sobre esta zona..."
              rows={2}
              className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:border-neon-blue focus:outline-none resize-none"
            />
          </div>
          
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg hover:bg-neon-blue/80 transition-colors font-medium disabled:opacity-50"
            >
              {saving ? 'Guardando...' : editingZone ? 'Actualizar' : 'Crear Zona'}
            </button>
          </div>
        </form>
      )}

      {zones.length === 0 ? (
        <div className="text-center py-12 bg-dark-card rounded-lg border border-dark-border">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-gray-400 mb-4">No hay zonas de envío configuradas</p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg hover:bg-neon-blue/80 transition-colors text-sm font-medium"
          >
            Agregar primera zona
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {zones.map((zone) => (
            <div
              key={zone.id}
              className={`bg-dark-card border rounded-lg p-4 ${zone.isActive ? 'border-dark-border' : 'border-dark-border/50 opacity-60'}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h4 className="font-medium text-white">{zone.name}</h4>
                    <span className="text-neon-blue font-medium">{currencySymbol}{zone.cost.toFixed(2)}</span>
                    {zone.freeAbove && (
                      <span className="text-xs px-2 py-0.5 bg-accent-success/20 text-accent-success rounded">
                        Gratis +{currencySymbol}{zone.freeAbove}
                      </span>
                    )}
                    {!zone.isActive && (
                      <span className="text-xs px-2 py-0.5 bg-accent-warning/20 text-accent-warning rounded">Inactiva</span>
                    )}
                  </div>
                  
                  {zone.districts.length > 0 && (
                    <p className="text-sm text-gray-400 mt-1">
                      <span className="text-gray-500">Distritos:</span> {zone.districts.join(', ')}
                    </p>
                  )}
                  
                  <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-400">
                    {zone.deliveryTime && (
                      <span>⏱️ {zone.deliveryTime}</span>
                    )}
                    {zone.address && (
                      <span>📍 {zone.address}</span>
                    )}
                  </div>
                  
                  {zone.policy && (
                    <p className="text-sm text-gray-500 mt-2 italic">{zone.policy}</p>
                  )}
                </div>
                
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggleActive(zone)}
                    className={`p-1.5 rounded transition-colors ${zone.isActive ? 'text-accent-success hover:bg-accent-success/20' : 'text-gray-500 hover:bg-dark-hover'}`}
                    title={zone.isActive ? 'Desactivar' : 'Activar'}
                  >
                    {zone.isActive ? '✓' : '○'}
                  </button>
                  <button
                    onClick={() => handleEdit(zone)}
                    className="p-1.5 text-gray-400 hover:text-neon-blue transition-colors"
                    title="Editar"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => handleDelete(zone.id)}
                    className="p-1.5 text-gray-400 hover:text-accent-error transition-colors"
                    title="Eliminar"
                  >
                    🗑
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showImportModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card rounded-lg p-6 max-w-lg w-full">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-white">Importar Zonas desde CSV</h3>
              <button onClick={() => setShowImportModal(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Formato del CSV:</label>
                <code className="block bg-dark-bg p-3 rounded text-xs text-gray-400 overflow-x-auto">
                  nombre,distritos,costo,gratisDesde,tiempoEntrega,direccion,politica<br/>
                  Lima Centro,"Miraflores,San Isidro",10,100,1-2 días,,Entrega estándar<br/>
                  Lima Norte,"Los Olivos,SMP",15,150,2-3 días,,<br/>
                </code>
              </div>
              
              <div>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-3 border-2 border-dashed border-dark-border rounded-lg text-gray-400 hover:border-neon-blue hover:text-neon-blue transition-colors"
                >
                  📁 Seleccionar archivo CSV
                </button>
              </div>
              
              {importData && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Vista previa:</label>
                  <pre className="bg-dark-bg p-3 rounded text-xs text-gray-400 overflow-x-auto max-h-32">
                    {importData.slice(0, 500)}
                    {importData.length > 500 && '...'}
                  </pre>
                </div>
              )}
              
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 bg-dark-hover text-gray-300 rounded-lg hover:bg-dark-border transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleImport}
                  disabled={importing || !importData}
                  className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg hover:bg-neon-blue/80 transition-colors font-medium disabled:opacity-50"
                >
                  {importing ? 'Importando...' : 'Importar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
