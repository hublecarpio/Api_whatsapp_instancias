'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Effi from './Effi';
import StepWhatsApp from './StepWhatsApp';
import StepProducts from './StepProducts';
import StepAgent from './StepAgent';
import { businessApi } from '@/lib/api';
import { useBusinessStore } from '@/store/business';

interface StarterProps {
  businessId: string;
  businessName: string;
  onComplete: () => void;
}

interface Business {
  id: string;
  name: string;
  onboardingCompleted?: boolean;
  [key: string]: any;
}

const STEPS = [
  { id: 1, title: 'Conectar WhatsApp', icon: '📱' },
  { id: 2, title: 'Agregar productos', icon: '🛍️' },
  { id: 3, title: 'Configurar asistente', icon: '🤖' },
];

const EFFI_MESSAGES = [
  '¡Hola! Soy Effi, tu asistente de configuración. Vamos a preparar tu negocio en 3 simples pasos.',
  'Ahora vamos a agregar algunos productos o servicios que ofreces.',
  '¡Último paso! Cuéntame sobre tu negocio para que el asistente IA pueda ayudar a tus clientes.',
];

export default function Starter({ businessId, businessName, onComplete }: StarterProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [stepCompleted, setStepCompleted] = useState<Record<number, boolean>>({});
  const [isExiting, setIsExiting] = useState(false);
  const { updateBusiness } = useBusinessStore();

  const handleStepComplete = (step: number) => {
    setStepCompleted(prev => ({ ...prev, [step]: true }));
    
    if (step < 3) {
      setTimeout(() => setCurrentStep(step + 1), 500);
    } else {
      handleFinish();
    }
  };

  const handleSkip = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    } else {
      handleFinish();
    }
  };

  const handleFinish = async () => {
    setIsExiting(true);
    
    try {
      await businessApi.update(businessId, { onboardingCompleted: true });
      updateBusiness(businessId, { onboardingCompleted: true } as Partial<Business>);
    } catch (error) {
      console.error('Error marking onboarding complete:', error);
    }
    
    setTimeout(onComplete, 800);
  };

  const getMood = () => {
    if (currentStep === 3 && stepCompleted[2]) return 'celebrating';
    if (Object.values(stepCompleted).some(v => v)) return 'happy';
    return 'thinking';
  };

  return (
    <AnimatePresence>
      {!isExiting && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-gradient-to-br from-[#0a0a14] via-[#12121f] to-[#0a0a14] flex flex-col"
        >
          <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full px-6 py-8">
            <div className="text-center mb-8">
              <motion.h1
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-3xl font-bold text-white mb-2"
              >
                ¡Bienvenido a {businessName}!
              </motion.h1>
              <p className="text-gray-400">Configura tu asistente de WhatsApp en minutos</p>
            </div>

            <div className="flex justify-center mb-10">
              <div className="flex items-center gap-2">
                {STEPS.map((step, index) => (
                  <div key={step.id} className="flex items-center">
                    <motion.div
                      animate={{
                        scale: currentStep === step.id ? 1.1 : 1,
                        backgroundColor: stepCompleted[step.id] 
                          ? '#25D366' 
                          : currentStep === step.id 
                            ? '#4F46E5' 
                            : '#374151'
                      }}
                      className="w-10 h-10 rounded-full flex items-center justify-center text-lg"
                    >
                      {stepCompleted[step.id] ? '✓' : step.icon}
                    </motion.div>
                    {index < STEPS.length - 1 && (
                      <div className={`w-16 h-1 mx-2 rounded ${
                        stepCompleted[step.id] ? 'bg-[#25D366]' : 'bg-gray-700'
                      }`} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-8">
              <Effi
                message={EFFI_MESSAGES[currentStep - 1]}
                mood={getMood()}
              />
            </div>

            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              className="flex-1 bg-[#1a1a2e]/50 rounded-2xl border border-gray-800 p-6 overflow-auto"
            >
              {currentStep === 1 && (
                <StepWhatsApp
                  businessId={businessId}
                  onComplete={() => handleStepComplete(1)}
                  onSkip={handleSkip}
                />
              )}
              {currentStep === 2 && (
                <StepProducts
                  businessId={businessId}
                  onComplete={() => handleStepComplete(2)}
                  onSkip={handleSkip}
                />
              )}
              {currentStep === 3 && (
                <StepAgent
                  businessId={businessId}
                  businessName={businessName}
                  onComplete={() => handleStepComplete(3)}
                  onSkip={handleSkip}
                />
              )}
            </motion.div>

            <div className="flex justify-between items-center mt-6">
              <button
                onClick={handleSkip}
                className="text-gray-400 hover:text-white transition text-sm"
              >
                {currentStep === 3 ? 'Terminar después' : 'Saltar este paso'}
              </button>
              
              <div className="text-gray-500 text-sm">
                Paso {currentStep} de {STEPS.length}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
