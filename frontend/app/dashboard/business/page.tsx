'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { businessApi, policyApi, billingApi } from '@/lib/api';

interface BusinessStats {
  whatsapp: { status: string; connected: boolean; phone: string | null };
  products: number;
  messages: number;
  contacts: number;
  orders: number;
  appointments: number;
  campaigns: number;
}

interface TokenUsage {
  tokensUsed: number;
  tokenLimit: number;
  percentUsed: number;
}

export default function BusinessPage() {
  const { currentBusiness, setCurrentBusiness, businesses, setBusinesses } = useBusinessStore();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [stats, setStats] = useState<BusinessStats | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [industry, setIndustry] = useState('');
  const [timezone, setTimezone] = useState('America/Lima');
  const [currencyCode, setCurrencyCode] = useState('PEN');
  const [currencySymbol, setCurrencySymbol] = useState('S/.');
  
  const [shippingPolicy, setShippingPolicy] = useState('');
  const [refundPolicy, setRefundPolicy] = useState('');
  const [brandVoice, setBrandVoice] = useState('');
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [businessObjective, setBusinessObjective] = useState<'SALES' | 'APPOINTMENTS'>('SALES');

  useEffect(() => {
    if (currentBusiness) {
      setName(currentBusiness.name);
      setDescription(currentBusiness.description || '');
      setIndustry(currentBusiness.industry || '');
      setTimezone(currentBusiness.timezone || 'America/Lima');
      setCurrencyCode(currentBusiness.currencyCode || 'PEN');
      setCurrencySymbol(currentBusiness.currencySymbol || 'S/.');
      setBusinessObjective((currentBusiness as any).businessObjective || 'SALES');
      
      policyApi.get(currentBusiness.id).then((res) => {
        if (res.data) {
          setShippingPolicy(res.data.shippingPolicy || '');
          setRefundPolicy(res.data.refundPolicy || '');
          setBrandVoice(res.data.brandVoice || '');
          setPolicyId(res.data.id);
        }
      }).catch(() => {});

      businessApi.getStats(currentBusiness.id).then((res) => {
        setStats(res.data);
      }).catch(() => {});

      billingApi.getTokenUsage().then((res) => {
        setTokenUsage({
          tokensUsed: res.data.tokensUsed,
          tokenLimit: res.data.tokenLimit,
          percentUsed: res.data.percentUsed
        });
      }).catch(() => {});
    }
  }, [currentBusiness]);

  const handleSaveBusiness = async () => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (currentBusiness) {
        await businessApi.update(currentBusiness.id, { name, description, industry, timezone, currencyCode, currencySymbol, businessObjective });
        
        const refreshed = await businessApi.get(currentBusiness.id);
        setCurrentBusiness(refreshed.data);
        setSuccess('Empresa actualizada correctamente');
      } else {
        const response = await businessApi.create({ name, description, industry, timezone, currencyCode, currencySymbol });
        setBusinesses([...businesses, response.data]);
        setCurrentBusiness(response.data);
        setSuccess('Empresa creada correctamente');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  const handleSavePolicy = async () => {
    if (!currentBusiness) return;
    
    setLoading(true);
    setError('');

    try {
      if (policyId) {
        await policyApi.update(policyId, { shippingPolicy, refundPolicy, brandVoice });
      } else {
        const response = await policyApi.create({
          businessId: currentBusiness.id,
          shippingPolicy,
          refundPolicy,
          brandVoice
        });
        setPolicyId(response.data.id);
      }
      setSuccess('Politicas guardadas correctamente');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar politicas');
    } finally {
      setLoading(false);
    }
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-0">
      <h1 className="text-xl sm:text-2xl font-bold text-white mb-6">
        {currentBusiness ? 'Mi Empresa' : 'Crear Empresa'}
      </h1>

      {currentBusiness && stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
          <div className="card p-3 text-center">
            <div className={`text-lg font-bold ${stats.whatsapp.connected ? 'text-accent-success' : 'text-accent-warning'}`}>
              {stats.whatsapp.connected ? '✓' : '✗'}
            </div>
            <div className="text-xs text-gray-400">WhatsApp</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-lg font-bold text-white">{tokenUsage ? `${tokenUsage.percentUsed}%` : '-'}</div>
            <div className="text-xs text-gray-400">Tokens</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-lg font-bold text-white">{formatNumber(stats.products)}</div>
            <div className="text-xs text-gray-400">Productos</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-lg font-bold text-white">{formatNumber(stats.messages)}</div>
            <div className="text-xs text-gray-400">Mensajes</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-lg font-bold text-white">{formatNumber(stats.contacts)}</div>
            <div className="text-xs text-gray-400">Contactos</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-lg font-bold text-white">{formatNumber(businessObjective === 'APPOINTMENTS' ? stats.appointments : stats.orders)}</div>
            <div className="text-xs text-gray-400">{businessObjective === 'APPOINTMENTS' ? 'Citas' : 'Ordenes'}</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-lg font-bold text-white">{formatNumber(stats.campaigns)}</div>
            <div className="text-xs text-gray-400">Campanas</div>
          </div>
        </div>
      )}

      {success && (
        <div className="bg-accent-success/10 border border-accent-success/20 text-accent-success px-4 py-3 rounded-lg mb-4">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-accent-error/10 border border-accent-error/20 text-accent-error px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Informacion basica</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Nombre de la empresa *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Descripcion
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input resize-none"
              rows={3}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Industria
            </label>
            <input
              type="text"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="input"
              placeholder="Ej: Tecnologia, Retail, Servicios..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Zona horaria
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="input"
            >
              <option value="America/Lima">America/Lima (Peru)</option>
              <option value="America/Bogota">America/Bogota (Colombia)</option>
              <option value="America/Mexico_City">America/Mexico_City (Mexico)</option>
              <option value="America/Argentina/Buenos_Aires">America/Buenos_Aires (Argentina)</option>
              <option value="America/Santiago">America/Santiago (Chile)</option>
              <option value="America/Sao_Paulo">America/Sao_Paulo (Brasil)</option>
              <option value="America/New_York">America/New_York (USA Este)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (USA Oeste)</option>
              <option value="Europe/Madrid">Europe/Madrid (Espana)</option>
              <option value="UTC">UTC</option>
            </select>
            <p className="text-xs text-gray-400 mt-1">
              Usado para variables dinamicas como {"{{now}}"}, {"{{date}}"}, {"{{time}}"}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Moneda
              </label>
              <select
                value={currencyCode}
                onChange={(e) => {
                  const code = e.target.value;
                  setCurrencyCode(code);
                  const symbols: Record<string, string> = {
                    'PEN': 'S/.',
                    'USD': '$',
                    'EUR': '€',
                    'MXN': '$',
                    'COP': '$',
                    'ARS': '$',
                    'CLP': '$',
                    'BRL': 'R$'
                  };
                  setCurrencySymbol(symbols[code] || '$');
                }}
                className="input"
              >
                <option value="PEN">PEN - Sol Peruano</option>
                <option value="USD">USD - Dolar Americano</option>
                <option value="EUR">EUR - Euro</option>
                <option value="MXN">MXN - Peso Mexicano</option>
                <option value="COP">COP - Peso Colombiano</option>
                <option value="ARS">ARS - Peso Argentino</option>
                <option value="CLP">CLP - Peso Chileno</option>
                <option value="BRL">BRL - Real Brasileno</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Simbolo
              </label>
              <input
                type="text"
                value={currencySymbol}
                onChange={(e) => setCurrencySymbol(e.target.value)}
                className="input"
                placeholder="S/."
              />
            </div>
          </div>
          
          <div className="mt-6 pt-6 border-t border-dark-border">
            <label className="block text-sm font-medium text-gray-300 mb-3">
              Objetivo del negocio
            </label>
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setBusinessObjective('SALES')}
                className={`p-4 rounded-lg border-2 transition-all ${
                  businessObjective === 'SALES' 
                    ? 'border-neon-blue bg-neon-blue/10 text-white' 
                    : 'border-dark-border bg-dark-surface text-gray-400 hover:border-gray-600'
                }`}
              >
                <div className="text-2xl mb-2">🛒</div>
                <div className="font-medium">Ventas</div>
                <div className="text-xs text-gray-500 mt-1">
                  E-commerce, pedidos, productos
                </div>
              </button>
              <button
                type="button"
                onClick={() => setBusinessObjective('APPOINTMENTS')}
                className={`p-4 rounded-lg border-2 transition-all ${
                  businessObjective === 'APPOINTMENTS' 
                    ? 'border-neon-blue bg-neon-blue/10 text-white' 
                    : 'border-dark-border bg-dark-surface text-gray-400 hover:border-gray-600'
                }`}
              >
                <div className="text-2xl mb-2">📅</div>
                <div className="font-medium">Citas</div>
                <div className="text-xs text-gray-500 mt-1">
                  Servicios, reuniones, calendario
                </div>
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Esto configura las herramientas del agente IA y las opciones del menu
            </p>
          </div>
        </div>
      </div>

      <button
        onClick={handleSaveBusiness}
        disabled={loading || !name}
        className="btn btn-primary mb-8 w-full sm:w-auto"
      >
        {loading ? 'Guardando...' : 'Guardar empresa'}
      </button>

      {currentBusiness && (
        <>
          {(currentBusiness as any)?.businessContext && Object.keys((currentBusiness as any).businessContext).length > 0 && (
            <div className="card mb-6 border-neon-blue/30">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Contexto del Negocio</h2>
                <span className="text-xs bg-neon-blue/20 text-neon-blue px-2 py-1 rounded">
                  Desde Prompt Master
                </span>
              </div>
              <p className="text-xs text-gray-400 mb-4">
                Datos inyectados desde Efficore Prompt Master. Para editar, usa el GPT y vuelve a enviar.
              </p>
              <div className="space-y-4">
                {(currentBusiness as any).businessContext.producto_principal && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Producto Principal</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.producto_principal}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.objetivo_negocio && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Objetivo del Negocio</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.objetivo_negocio}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.cliente_ideal && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Cliente Ideal</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.cliente_ideal}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.dolores_principales && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Dolores Principales</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.dolores_principales}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.objeciones_frecuentes && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Objeciones Frecuentes</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.objeciones_frecuentes}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.tono_agente && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Tono del Agente</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.tono_agente}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.jergas?.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Jergas / Expresiones</label>
                    <div className="flex flex-wrap gap-1">
                      {(currentBusiness as any).businessContext.jergas.map((j: string, i: number) => (
                        <span key={i} className="text-xs bg-dark-bg text-gray-300 px-2 py-1 rounded">{j}</span>
                      ))}
                    </div>
                  </div>
                )}
                {(currentBusiness as any).businessContext.info_operativa && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Info Operativa</label>
                    <p className="text-sm text-white bg-dark-bg rounded p-2">{(currentBusiness as any).businessContext.info_operativa}</p>
                  </div>
                )}
                {(currentBusiness as any).businessContext.preguntas_frecuentes?.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Preguntas Frecuentes</label>
                    <ul className="text-sm text-white bg-dark-bg rounded p-2 list-disc list-inside space-y-1">
                      {(currentBusiness as any).businessContext.preguntas_frecuentes.map((p: string, i: number) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {(currentBusiness as any).businessContext.enlaces_relevantes?.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Enlaces Relevantes</label>
                    <div className="space-y-1">
                      {(currentBusiness as any).businessContext.enlaces_relevantes.map((e: string, i: number) => (
                        <a key={i} href={e} target="_blank" rel="noopener noreferrer" className="block text-sm text-neon-blue hover:underline">{e}</a>
                      ))}
                    </div>
                  </div>
                )}
                {(currentBusiness as any).businessContext.lastUpdated && (
                  <p className="text-xs text-gray-500 mt-2">
                    Actualizado: {new Date((currentBusiness as any).businessContext.lastUpdated).toLocaleString('es-PE')}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="card mb-6">
            <h2 className="text-lg font-semibold text-white mb-4">Politicas del negocio</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Politica de envios
                </label>
                <textarea
                  value={shippingPolicy}
                  onChange={(e) => setShippingPolicy(e.target.value)}
                  className="input resize-none"
                  rows={2}
                  placeholder="Describe como manejas los envios..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Politica de devoluciones
                </label>
                <textarea
                  value={refundPolicy}
                  onChange={(e) => setRefundPolicy(e.target.value)}
                  className="input resize-none"
                  rows={2}
                  placeholder="Describe tu politica de devoluciones..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Tono de marca
                </label>
                <textarea
                  value={brandVoice}
                  onChange={(e) => setBrandVoice(e.target.value)}
                  className="input resize-none"
                  rows={2}
                  placeholder="Ej: Amigable, profesional, cercano..."
                />
              </div>
            </div>
            <button
              onClick={handleSavePolicy}
              disabled={loading}
              className="btn btn-secondary mt-4"
            >
              Guardar politicas
            </button>
          </div>
        </>
      )}
    </div>
  );
}
