'use client';

import { useState } from 'react';
import { promptImporterApi } from '@/lib/api';

interface PromptImporterProps {
  businessId: string;
  onImportComplete?: () => void;
}

interface AnalysisResult {
  success: boolean;
  config: {
    businessInfo: {
      name?: string;
      description?: string;
      industry?: string;
      country?: string;
      city?: string;
      currency?: string;
      timezone?: string;
      workingHours?: string;
      paymentMethods?: string[];
    };
    products: { title: string; description?: string; price: number; category?: string }[];
    extractionFields: { key: string; label: string; description?: string }[];
    funnelStages: { name: string; description?: string; order: number; requiredFields?: string[]; blockedTopics?: string[] }[];
    objections: { trigger: string; response: string; category?: string }[];
    deliveryZones: { name: string; price: number; estimatedTime?: string }[];
    agentPrompt?: string;
    agentPersonality?: string;
  };
  missing: string[];
  warnings: string[];
  conflicts: {
    products: string[];
    extractionFields: string[];
    funnelStages: string[];
    objections: string[];
    deliveryZones: string[];
  };
  confidence: number;
  existingCounts: {
    products: number;
    extractionFields: number;
    funnelStages: number;
    objections: number;
    deliveryZones: number;
  };
}

interface ImportResult {
  success: boolean;
  summary: {
    totalCreated: number;
    totalSkipped: number;
    totalErrors: number;
  };
  details: Record<string, { created: number; skipped: number; errors: string[] }>;
}

export default function PromptImporter({ businessId, onImportComplete }: PromptImporterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [rawPrompt, setRawPrompt] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'input' | 'preview' | 'result'>('input');

  const handleAnalyze = async () => {
    if (!rawPrompt.trim()) {
      setError('Por favor ingresa el texto del prompt');
      return;
    }

    setAnalyzing(true);
    setError(null);

    try {
      const res = await promptImporterApi.analyze(businessId, rawPrompt);
      setAnalysis(res.data);
      setStep('preview');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al analizar el prompt');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleImport = async () => {
    if (!analysis?.config) return;

    setImporting(true);
    setError(null);

    try {
      const res = await promptImporterApi.import(businessId, analysis.config, { skipConflicts: true });
      setImportResult(res.data);
      setStep('result');
      onImportComplete?.();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al importar la configuracion');
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setRawPrompt('');
    setAnalysis(null);
    setImportResult(null);
    setError(null);
    setStep('input');
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-green-400';
    if (confidence >= 0.6) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm font-medium"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Importar desde Prompt
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1a1a1a] rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h2 className="text-lg font-semibold text-white">Importador Inteligente</h2>
                <p className="text-sm text-gray-400">Pega tu prompt y configuramos todo automaticamente</p>
              </div>
              <button onClick={handleClose} className="text-gray-400 hover:text-white">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {step === 'input' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">
                      Pega aqui toda la informacion de tu negocio (productos, precios, zonas de envio, instrucciones del agente, etc.)
                    </label>
                    <textarea
                      value={rawPrompt}
                      onChange={(e) => setRawPrompt(e.target.value)}
                      placeholder="Ejemplo:&#10;Somos DUVON Perfumes, vendemos perfumes de alta gama...&#10;&#10;PRODUCTOS:&#10;- Dior Sauvage 100ml - S/. 89&#10;- Chanel Bleu 100ml - S/. 95&#10;&#10;ZONAS DE ENVIO:&#10;- Lima Centro: S/. 10&#10;- Lima Norte: S/. 12&#10;&#10;DATOS A RECOLECTAR:&#10;- Nombre completo&#10;- Direccion de envio&#10;- Distrito&#10;..."
                      className="w-full h-64 bg-[#2a2a2a] border border-gray-600 rounded-lg p-3 text-white text-sm resize-none focus:outline-none focus:border-purple-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Maximo 50,000 caracteres ({rawPrompt.length.toLocaleString()} usados)
                    </p>
                  </div>

                  {error && (
                    <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
                      {error}
                    </div>
                  )}

                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                    <h3 className="text-blue-400 font-medium mb-2">Que puede detectar:</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm text-gray-300">
                      <span>• Productos y precios</span>
                      <span>• Zonas de envio</span>
                      <span>• Campos a extraer</span>
                      <span>• Etapas del funnel</span>
                      <span>• Manejo de objeciones</span>
                      <span>• Prompt del agente</span>
                    </div>
                  </div>
                </div>
              )}

              {step === 'preview' && analysis && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between bg-[#2a2a2a] rounded-lg p-4">
                    <div>
                      <p className="text-white font-medium">Analisis Completado</p>
                      <p className={`text-sm ${getConfidenceColor(analysis.confidence)}`}>
                        Confianza: {Math.round(analysis.confidence * 100)}%
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-green-400 text-sm">
                        {analysis.config.products.length} productos
                      </span>
                      <span className="text-gray-500">|</span>
                      <span className="text-blue-400 text-sm">
                        {analysis.config.extractionFields.length} campos
                      </span>
                      <span className="text-gray-500">|</span>
                      <span className="text-purple-400 text-sm">
                        {analysis.config.funnelStages.length} etapas
                      </span>
                    </div>
                  </div>

                  {analysis.missing.length > 0 && (
                    <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
                      <h3 className="text-yellow-400 font-medium mb-2 flex items-center gap-2">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        Datos Faltantes
                      </h3>
                      <ul className="text-sm text-gray-300 space-y-1">
                        {analysis.missing.map((item, i) => (
                          <li key={i}>• {item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {Object.values(analysis.conflicts).some(arr => arr.length > 0) && (
                    <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
                      <h3 className="text-orange-400 font-medium mb-2">Conflictos (se omitiran)</h3>
                      <div className="text-sm text-gray-300 space-y-1">
                        {analysis.conflicts.products.length > 0 && (
                          <p>Productos existentes: {analysis.conflicts.products.join(', ')}</p>
                        )}
                        {analysis.conflicts.extractionFields.length > 0 && (
                          <p>Campos existentes: {analysis.conflicts.extractionFields.join(', ')}</p>
                        )}
                        {analysis.conflicts.funnelStages.length > 0 && (
                          <p>Etapas existentes: {analysis.conflicts.funnelStages.join(', ')}</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="space-y-3">
                    {analysis.config.products.length > 0 && (
                      <details className="bg-[#2a2a2a] rounded-lg overflow-hidden">
                        <summary className="px-4 py-3 cursor-pointer text-white font-medium flex items-center justify-between">
                          <span>Productos ({analysis.config.products.length})</span>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4 space-y-2">
                          {analysis.config.products.map((p, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="text-gray-300">{p.title}</span>
                              <span className="text-green-400">S/. {p.price}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {analysis.config.extractionFields.length > 0 && (
                      <details className="bg-[#2a2a2a] rounded-lg overflow-hidden">
                        <summary className="px-4 py-3 cursor-pointer text-white font-medium flex items-center justify-between">
                          <span>Campos de Extraccion ({analysis.config.extractionFields.length})</span>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4 space-y-2">
                          {analysis.config.extractionFields.map((f, i) => (
                            <div key={i} className="text-sm">
                              <span className="text-blue-400">{f.key}</span>
                              <span className="text-gray-500"> - </span>
                              <span className="text-gray-300">{f.label}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {analysis.config.funnelStages.length > 0 && (
                      <details className="bg-[#2a2a2a] rounded-lg overflow-hidden">
                        <summary className="px-4 py-3 cursor-pointer text-white font-medium flex items-center justify-between">
                          <span>Etapas del Funnel ({analysis.config.funnelStages.length})</span>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4 space-y-2">
                          {analysis.config.funnelStages.map((s, i) => (
                            <div key={i} className="text-sm">
                              <span className="text-purple-400">{s.order}. {s.name}</span>
                              {s.description && <p className="text-gray-500 text-xs ml-4">{s.description}</p>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {analysis.config.deliveryZones.length > 0 && (
                      <details className="bg-[#2a2a2a] rounded-lg overflow-hidden">
                        <summary className="px-4 py-3 cursor-pointer text-white font-medium flex items-center justify-between">
                          <span>Zonas de Envio ({analysis.config.deliveryZones.length})</span>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4 space-y-2">
                          {analysis.config.deliveryZones.map((z, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="text-gray-300">{z.name}</span>
                              <span className="text-yellow-400">S/. {z.price}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {analysis.config.objections.length > 0 && (
                      <details className="bg-[#2a2a2a] rounded-lg overflow-hidden">
                        <summary className="px-4 py-3 cursor-pointer text-white font-medium flex items-center justify-between">
                          <span>Manejo de Objeciones ({analysis.config.objections.length})</span>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4 space-y-2">
                          {analysis.config.objections.map((o, i) => (
                            <div key={i} className="text-sm">
                              <span className="text-red-400">"{o.trigger}"</span>
                              <p className="text-gray-400 text-xs ml-4 mt-1">{o.response.substring(0, 100)}...</p>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {analysis.config.agentPrompt && (
                      <details className="bg-[#2a2a2a] rounded-lg overflow-hidden">
                        <summary className="px-4 py-3 cursor-pointer text-white font-medium flex items-center justify-between">
                          <span>Prompt del Agente</span>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4">
                          <p className="text-gray-300 text-sm whitespace-pre-wrap">
                            {analysis.config.agentPrompt.substring(0, 500)}
                            {analysis.config.agentPrompt.length > 500 && '...'}
                          </p>
                        </div>
                      </details>
                    )}
                  </div>

                  {error && (
                    <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
                      {error}
                    </div>
                  )}
                </div>
              )}

              {step === 'result' && importResult && (
                <div className="space-y-4">
                  <div className="bg-green-500/20 border border-green-500/30 rounded-lg p-6 text-center">
                    <svg className="w-16 h-16 text-green-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h3 className="text-xl font-semibold text-white mb-2">Importacion Completada</h3>
                    <div className="flex justify-center gap-6 text-sm">
                      <div>
                        <p className="text-2xl font-bold text-green-400">{importResult.summary.totalCreated}</p>
                        <p className="text-gray-400">Creados</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-yellow-400">{importResult.summary.totalSkipped}</p>
                        <p className="text-gray-400">Omitidos</p>
                      </div>
                      {importResult.summary.totalErrors > 0 && (
                        <div>
                          <p className="text-2xl font-bold text-red-400">{importResult.summary.totalErrors}</p>
                          <p className="text-gray-400">Errores</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-[#2a2a2a] rounded-lg p-4">
                    <h4 className="text-white font-medium mb-3">Detalles por categoria:</h4>
                    <div className="space-y-2">
                      {Object.entries(importResult.details).map(([key, value]) => (
                        value.created > 0 || value.skipped > 0 ? (
                          <div key={key} className="flex justify-between text-sm">
                            <span className="text-gray-300 capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
                            <span>
                              <span className="text-green-400">{value.created} creados</span>
                              {value.skipped > 0 && (
                                <span className="text-yellow-400 ml-2">{value.skipped} omitidos</span>
                              )}
                            </span>
                          </div>
                        ) : null
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 p-4 border-t border-gray-700">
              {step === 'input' && (
                <>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleAnalyze}
                    disabled={analyzing || !rawPrompt.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {analyzing ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Analizando...
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        Analizar con IA
                      </>
                    )}
                  </button>
                </>
              )}

              {step === 'preview' && (
                <>
                  <button
                    onClick={() => setStep('input')}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                    Volver
                  </button>
                  <button
                    onClick={handleImport}
                    disabled={importing}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {importing ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Importando...
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Confirmar e Importar
                      </>
                    )}
                  </button>
                </>
              )}

              {step === 'result' && (
                <button
                  onClick={handleClose}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg transition-colors"
                >
                  Cerrar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
