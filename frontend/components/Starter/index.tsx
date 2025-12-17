'use client';

import { useState } from 'react';
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
  { id: 1, title: 'WhatsApp', icon: '📱' },
  { id: 2, title: 'Productos', icon: '🛍️' },
  { id: 3, title: 'Asistente', icon: '🤖' },
];

const EFFI_MESSAGES = [
  '¡Hola! Soy Effi. Vamos a conectar tu WhatsApp para empezar.',
  'Ahora agrega algunos productos o servicios que ofreces.',
  '¡Último paso! Configura cómo responderá tu asistente IA.',
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

  const handleSkipStep = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    } else {
      handleFinish();
    }
  };

  const handleSkipAll = async () => {
    setIsExiting(true);
    
    try {
      await businessApi.update(businessId, { onboardingCompleted: true });
      updateBusiness(businessId, { onboardingCompleted: true } as Partial<Business>);
    } catch (error) {
      console.error('Error marking onboarding complete:', error);
    }
    
    setTimeout(onComplete, 300);
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
          className="fixed inset-0 z-50 bg-gradient-to-br from-[#0a0a14] via-[#12121f] to-[#0a0a14] flex flex-col overflow-auto"
        >
          <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full px-3 sm:px-6 py-4 sm:py-8">
            <div className="flex justify-between items-start mb-4 sm:mb-6">
              <div className="flex-1">
                <motion.h1
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xl sm:text-3xl font-bold text-white mb-1"
                >
                  ¡Bienvenido!
                </motion.h1>
                <p className="text-gray-400 text-sm sm:text-base truncate">{businessName}</p>
              </div>
              <button
                onClick={handleSkipAll}
                className="text-gray-500 hover:text-white transition text-xs sm:text-sm px-3 py-1.5 rounded-lg hover:bg-gray-800/50 flex-shrink-0"
              >
                Saltar tutorial →
              </button>
            </div>

            <div className="flex justify-center mb-4 sm:mb-8">
              <div className="flex items-center gap-1 sm:gap-2">
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
                      className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-sm sm:text-lg"
                    >
                      {stepCompleted[step.id] ? '✓' : step.icon}
                    </motion.div>
                    {index < STEPS.length - 1 && (
                      <div className={`w-8 sm:w-16 h-1 mx-1 sm:mx-2 rounded ${
                        stepCompleted[step.id] ? 'bg-[#25D366]' : 'bg-gray-700'
                      }`} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-4 sm:mb-6">
              <Effi
                message={EFFI_MESSAGES[currentStep - 1]}
                mood={getMood()}
                compact={true}
              />
            </div>

            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              className="flex-1 bg-[#1a1a2e]/50 rounded-xl sm:rounded-2xl border border-gray-800 p-3 sm:p-6 overflow-auto min-h-0"
            >
              {currentStep === 1 && (
                <StepWhatsApp
                  businessId={businessId}
                  onComplete={() => handleStepComplete(1)}
                  onSkip={handleSkipStep}
                />
              )}
              {currentStep === 2 && (
                <StepProducts
                  businessId={businessId}
                  onComplete={() => handleStepComplete(2)}
                  onSkip={handleSkipStep}
                />
              )}
              {currentStep === 3 && (
                <StepAgent
                  businessId={businessId}
                  businessName={businessName}
                  onComplete={() => handleStepComplete(3)}
                  onSkip={handleSkipStep}
                />
              )}
            </motion.div>

            <div className="flex justify-between items-center mt-4 sm:mt-6 pb-2">
              <button
                onClick={handleSkipStep}
                className="text-gray-400 hover:text-white transition text-xs sm:text-sm"
              >
                {currentStep === 3 ? 'Terminar después' : 'Saltar paso'}
              </button>
              
              <div className="text-gray-500 text-xs sm:text-sm">
                {currentStep} / {STEPS.length}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
