'use client';

import { useState, useEffect } from 'react';
import { useBusinessStore } from '@/store/business';
import { businessApi, policyApi } from '@/lib/api';

export default function BusinessPage() {
  const { currentBusiness, setCurrentBusiness, businesses, setBusinesses } = useBusinessStore();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [industry, setIndustry] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4.1-mini');
  
  const [shippingPolicy, setShippingPolicy] = useState('');
  const [refundPolicy, setRefundPolicy] = useState('');
  const [brandVoice, setBrandVoice] = useState('');
  const [policyId, setPolicyId] = useState<string | null>(null);

  useEffect(() => {
    if (currentBusiness) {
      setName(currentBusiness.name);
      setDescription(currentBusiness.description || '');
      setIndustry(currentBusiness.industry || '');
      setOpenaiModel(currentBusiness.openaiModel || 'gpt-4.1-mini');
      
      policyApi.get(currentBusiness.id).then((res) => {
        if (res.data) {
          setShippingPolicy(res.data.shippingPolicy || '');
          setRefundPolicy(res.data.refundPolicy || '');
          setBrandVoice(res.data.brandVoice || '');
          setPolicyId(res.data.id);
        }
      }).catch(() => {});
    }
  }, [currentBusiness]);

  const handleSaveBusiness = async () => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (currentBusiness) {
        await businessApi.update(currentBusiness.id, { name, description, industry });
        
        if (openaiApiKey) {
          await businessApi.updateOpenAI(currentBusiness.id, { openaiApiKey, openaiModel });
        }
        
        const refreshed = await businessApi.get(currentBusiness.id);
        setCurrentBusiness(refreshed.data);
        setSuccess('Empresa actualizada correctamente');
      } else {
        const response = await businessApi.create({ name, description, industry });
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

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-0">
      <h1 className="text-xl sm:text-2xl font-bold text-white mb-6">
        {currentBusiness ? 'Configurar Empresa' : 'Crear Empresa'}
      </h1>

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
        </div>
      </div>

      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-white mb-4">Configuracion de IA</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              API Key de OpenAI
            </label>
            <input
              type="password"
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              className="input"
              placeholder="sk-..."
            />
            <p className="text-xs text-gray-500 mt-1">
              Obten tu API key en platform.openai.com
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Modelo
            </label>
            <select
              value={openaiModel}
              onChange={(e) => setOpenaiModel(e.target.value)}
              className="input"
            >
              <option value="gpt-4.1-mini">GPT-4.1 Mini (recomendado)</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
            </select>
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
