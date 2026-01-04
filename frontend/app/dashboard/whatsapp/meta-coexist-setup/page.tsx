'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { waApi } from '@/lib/api';

interface MetaBusiness {
  id: string;
  name: string;
}

interface WabaInfo {
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

interface PhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
}

function MetaCoexistSetupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionToken = searchParams.get('session');
  
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState(1);
  
  const [sessionData, setSessionData] = useState<{
    instanceId: string;
    businessId: string;
    metaBusinesses: MetaBusiness[];
  } | null>(null);
  
  const [selectedMetaBusiness, setSelectedMetaBusiness] = useState<string>('');
  const [wabas, setWabas] = useState<WabaInfo[]>([]);
  const [selectedWaba, setSelectedWaba] = useState<string>('');
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string>('');
  const [loadingWabas, setLoadingWabas] = useState(false);
  const [loadingPhones, setLoadingPhones] = useState(false);

  useEffect(() => {
    if (!sessionToken) {
      setError('Session invalida. Por favor inicia el proceso de nuevo.');
      setLoading(false);
      return;
    }

    const fetchSession = async () => {
      try {
        const response = await waApi.getMetaCoexistSession(sessionToken);
        setSessionData(response.data);
        
        if (response.data.metaBusinesses?.length === 1) {
          setSelectedMetaBusiness(response.data.metaBusinesses[0].id);
        }
      } catch (err: any) {
        setError(err.response?.data?.error || 'Session expirada. Por favor inicia el proceso de nuevo.');
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
  }, [sessionToken]);

  useEffect(() => {
    if (!selectedMetaBusiness || !sessionToken) return;

    const fetchWabas = async () => {
      setLoadingWabas(true);
      setWabas([]);
      setSelectedWaba('');
      setPhoneNumbers([]);
      setSelectedPhone('');
      
      try {
        const response = await waApi.getMetaCoexistWabas(sessionToken, selectedMetaBusiness);
        setWabas(response.data.wabas || []);
        
        if (response.data.wabas?.length === 1) {
          setSelectedWaba(response.data.wabas[0].id);
        }
      } catch (err: any) {
        setError('Error al cargar las cuentas de WhatsApp Business');
      } finally {
        setLoadingWabas(false);
      }
    };

    fetchWabas();
  }, [selectedMetaBusiness, sessionToken]);

  useEffect(() => {
    if (!selectedWaba || !sessionToken) return;

    const fetchPhoneNumbers = async () => {
      setLoadingPhones(true);
      setPhoneNumbers([]);
      setSelectedPhone('');
      
      try {
        const response = await waApi.getMetaCoexistPhoneNumbers(sessionToken, selectedWaba);
        setPhoneNumbers(response.data.phoneNumbers || []);
        
        if (response.data.phoneNumbers?.length === 1) {
          setSelectedPhone(response.data.phoneNumbers[0].id);
        }
      } catch (err: any) {
        setError('Error al cargar los numeros de telefono');
      } finally {
        setLoadingPhones(false);
      }
    };

    fetchPhoneNumbers();
  }, [selectedWaba, sessionToken]);

  const handleSubmit = async () => {
    if (!sessionToken || !selectedMetaBusiness || !selectedWaba || !selectedPhone) {
      setError('Por favor selecciona todas las opciones');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await waApi.setupMetaCoexist({
        sessionToken,
        metaBusinessId: selectedMetaBusiness,
        wabaId: selectedWaba,
        phoneNumberId: selectedPhone
      });

      if (sessionData?.instanceId) {
        await waApi.activateMetaCoexist(sessionData.instanceId);
      }

      router.push('/dashboard/whatsapp?success=coexist');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al configurar Meta Coexistence');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedPhoneInfo = phoneNumbers.find(p => p.id === selectedPhone);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Cargando datos de Facebook...</p>
        </div>
      </div>
    );
  }

  if (error && !sessionData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="card max-w-md w-full text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-white mb-2">Error de Autorizacion</h1>
          <p className="text-gray-400 mb-6">{error}</p>
          <button
            onClick={() => router.push('/dashboard/whatsapp')}
            className="btn btn-primary w-full"
          >
            Volver a WhatsApp
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-bg p-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-purple-500/20 mb-4">
            <span className="text-3xl">🔗</span>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Configurar Meta Coexistence</h1>
          <p className="text-gray-400">Conecta tu WhatsApp Business App existente</p>
        </div>

        <div className="flex justify-center mb-8">
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((s) => (
              <div key={s} className="flex items-center">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step >= s ? 'bg-purple-500 text-white' : 'bg-dark-hover text-gray-500'
                }`}>
                  {s}
                </div>
                {s < 3 && (
                  <div className={`w-12 h-1 mx-1 ${
                    step > s ? 'bg-purple-500' : 'bg-dark-hover'
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          {error && (
            <div className="bg-accent-error/10 border border-accent-error/30 text-accent-error px-4 py-3 rounded-lg mb-6">
              {error}
            </div>
          )}

          {step === 1 && (
            <div>
              <h2 className="text-lg font-semibold text-white mb-4">
                1. Selecciona tu cuenta de Meta Business
              </h2>
              <div className="space-y-3">
                {sessionData?.metaBusinesses?.map((business) => (
                  <button
                    key={business.id}
                    onClick={() => {
                      setSelectedMetaBusiness(business.id);
                      setStep(2);
                    }}
                    className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                      selectedMetaBusiness === business.id
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-dark-hover hover:border-purple-500/50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                        <span className="text-lg">🏢</span>
                      </div>
                      <div>
                        <p className="font-medium text-white">{business.name}</p>
                        <p className="text-xs text-gray-500">ID: {business.id}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <button
                onClick={() => setStep(1)}
                className="text-sm text-gray-400 hover:text-white mb-4 flex items-center gap-1"
              >
                ← Volver
              </button>
              <h2 className="text-lg font-semibold text-white mb-4">
                2. Selecciona tu cuenta de WhatsApp Business (WABA)
              </h2>
              
              {loadingWabas ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500 mx-auto mb-2"></div>
                  <p className="text-gray-400 text-sm">Cargando cuentas...</p>
                </div>
              ) : wabas.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-400">No se encontraron cuentas de WhatsApp Business</p>
                  <p className="text-sm text-gray-500 mt-2">Asegurate de tener una WABA asociada a tu Meta Business</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {wabas.map((waba) => (
                    <button
                      key={waba.id}
                      onClick={() => {
                        setSelectedWaba(waba.id);
                        setStep(3);
                      }}
                      className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                        selectedWaba === waba.id
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-dark-hover hover:border-purple-500/50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                          <span className="text-lg">📱</span>
                        </div>
                        <div>
                          <p className="font-medium text-white">{waba.name || 'WhatsApp Business Account'}</p>
                          <p className="text-xs text-gray-500">
                            {waba.currency} • {waba.timezone}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div>
              <button
                onClick={() => setStep(2)}
                className="text-sm text-gray-400 hover:text-white mb-4 flex items-center gap-1"
              >
                ← Volver
              </button>
              <h2 className="text-lg font-semibold text-white mb-4">
                3. Selecciona tu numero de telefono
              </h2>
              
              {loadingPhones ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500 mx-auto mb-2"></div>
                  <p className="text-gray-400 text-sm">Cargando numeros...</p>
                </div>
              ) : phoneNumbers.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-400">No se encontraron numeros de telefono</p>
                  <p className="text-sm text-gray-500 mt-2">Asegurate de tener un numero registrado en tu WABA</p>
                </div>
              ) : (
                <div className="space-y-3 mb-6">
                  {phoneNumbers.map((phone) => (
                    <button
                      key={phone.id}
                      onClick={() => setSelectedPhone(phone.id)}
                      className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                        selectedPhone === phone.id
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-dark-hover hover:border-purple-500/50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-neon-blue/20 flex items-center justify-center">
                          <span className="text-lg">📞</span>
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-white">{phone.display_phone_number}</p>
                          <p className="text-xs text-gray-500">{phone.verified_name}</p>
                        </div>
                        <div className={`px-2 py-1 rounded text-xs ${
                          phone.quality_rating === 'GREEN' 
                            ? 'bg-accent-success/20 text-accent-success'
                            : phone.quality_rating === 'YELLOW'
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'bg-accent-error/20 text-accent-error'
                        }`}>
                          {phone.quality_rating || 'N/A'}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {selectedPhone && (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 mb-6">
                  <h3 className="text-sm font-medium text-purple-400 mb-2">Resumen</h3>
                  <ul className="text-sm text-gray-300 space-y-1">
                    <li>Meta Business: {sessionData?.metaBusinesses?.find(b => b.id === selectedMetaBusiness)?.name}</li>
                    <li>WABA: {wabas.find(w => w.id === selectedWaba)?.name || selectedWaba}</li>
                    <li>Telefono: {selectedPhoneInfo?.display_phone_number}</li>
                  </ul>
                </div>
              )}

              <button
                onClick={handleSubmit}
                disabled={!selectedPhone || submitting}
                className="w-full btn btn-primary"
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Configurando...
                  </span>
                ) : (
                  'Conectar WhatsApp'
                )}
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 text-center">
          <button
            onClick={() => router.push('/dashboard/whatsapp')}
            className="text-sm text-gray-400 hover:text-white"
          >
            Cancelar y volver
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MetaCoexistSetupPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-dark-bg">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
      </div>
    }>
      <MetaCoexistSetupContent />
    </Suspense>
  );
}
