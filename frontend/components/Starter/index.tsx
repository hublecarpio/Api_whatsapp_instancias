'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Effi from './Effi';
import StepWhatsApp from './StepWhatsApp';
import StepAgent from './StepAgent';
import { businessApi } from '@/lib/api';
import { useBusinessStore } from '@/store/business';
import { useGlass } from '@/components/GlassProvider';

interface StarterProps {
  businessId: string;
  businessName: string;
  onComplete: () => void;
}

interface Business {
  id: string;
  name: string;
  onboardingCompleted?: boolean;
  onboardingSkipped?: boolean;
  [key: string]: any;
}

const STEPS = [
  { id: 1, title: 'WhatsApp', icon: '📱' },
  { id: 2, title: 'Asistente', icon: '🤖' },
];

const EFFI_MESSAGES = [
  '¡Hola! Soy Effi. Vamos a conectar tu WhatsApp para empezar.',
  '¡Ultimo paso! Configura como responder tu asistente IA.',
];

export default function Starter({ businessId, businessName, onComplete }: StarterProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [stepCompleted, setStepCompleted] = useState<Record<number, boolean>>({});
  const [isExiting, setIsExiting] = useState(false);
  const [showFinalScreen, setShowFinalScreen] = useState(false);
  const { updateBusiness } = useBusinessStore();
  const { glassMode } = useGlass();
  
  const bgClass = glassMode 
    ? "fixed inset-0 z-50 bg-black/90 backdrop-blur-xl flex items-center justify-center overflow-auto p-4"
    : "fixed inset-0 z-50 bg-gradient-to-br from-[#0a0a14] via-[#12121f] to-[#0a0a14] flex items-center justify-center overflow-auto p-4";

  const handleStepComplete = (step: number) => {
    const newStepCompleted = { ...stepCompleted, [step]: true };
    setStepCompleted(newStepCompleted);
    
    if (step < 2) {
      setTimeout(() => setCurrentStep(step + 1), 500);
    } else {
      handleFinish(newStepCompleted);
    }
  };

  const handleSkipStep = () => {
    if (currentStep < 2) {
      setCurrentStep(currentStep + 1);
    } else {
      handleFinish(stepCompleted);
    }
  };

  const handleSkipAll = async () => {
    setIsExiting(true);
    
    try {
      await businessApi.update(businessId, { onboardingSkipped: true });
      updateBusiness(businessId, { onboardingSkipped: true } as Partial<Business>);
    } catch (error) {
      console.error('Error marking onboarding skipped:', error);
    }
    
    setTimeout(onComplete, 300);
  };

  const handleFinish = async (completedSteps: Record<number, boolean>) => {
    const whatsAppCompleted = completedSteps[1] === true;
    const agentCompleted = completedSteps[2] === true;
    const bothCompleted = whatsAppCompleted && agentCompleted;
    
    try {
      if (bothCompleted) {
        await businessApi.update(businessId, { onboardingCompleted: true, onboardingSkipped: false });
        updateBusiness(businessId, { onboardingCompleted: true, onboardingSkipped: false } as Partial<Business>);
      } else {
        await businessApi.update(businessId, { onboardingSkipped: true });
        updateBusiness(businessId, { onboardingSkipped: true } as Partial<Business>);
      }
    } catch (error) {
      console.error('Error updating onboarding status:', error);
    }
    
    if (bothCompleted) {
      setShowFinalScreen(true);
    } else {
      setIsExiting(true);
      setTimeout(onComplete, 300);
    }
  };

  const handleCloseFinal = () => {
    setIsExiting(true);
    setTimeout(onComplete, 300);
  };

  const getMood = () => {
    if (showFinalScreen) return 'celebrating';
    if (Object.values(stepCompleted).some(v => v)) return 'happy';
    return 'thinking';
  };

  if (showFinalScreen) {
    return (
      <AnimatePresence>
        {!isExiting && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={bgClass}
          >
            <div className="flex flex-col max-w-2xl w-full bg-[#12121f]/80 backdrop-blur-sm rounded-2xl border border-gray-700/50 shadow-2xl">
              <div className="flex flex-col items-center justify-center px-6 py-8">
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.2, type: 'spring' }}
                  className="text-center"
                >
                  <Effi message="¡Todo listo! Tu asistente esta preparado." mood="celebrating" />
                  
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 }}
                    className="mt-8"
                  >
                    <div className="bg-[#25D366]/10 border border-[#25D366]/30 rounded-2xl p-6 mb-6">
                      <div className="text-5xl mb-4">🎉</div>
                      <h2 className="text-2xl font-bold text-white mb-3">
                        ¡Configuracion completada!
                      </h2>
                      <p className="text-gray-300 text-lg mb-4">
                        Ahora hablale a tu numero de WhatsApp y prueba tu agente
                      </p>
                      <div className="bg-[#1a1a2e] rounded-xl p-4 text-left">
                        <p className="text-gray-400 text-sm mb-2">Tip:</p>
                        <p className="text-white text-sm">
                          Envia un mensaje desde otro telefono al numero que conectaste y veras como tu asistente responde automaticamente.
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={handleCloseFinal}
                      className="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition text-lg"
                    >
                      Ir al panel →
                    </button>
                  </motion.div>
                </motion.div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {!isExiting && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={bgClass}
        >
          <div className="flex flex-col max-w-4xl w-full bg-[#12121f]/80 backdrop-blur-sm rounded-2xl border border-gray-700/50 shadow-2xl max-h-[calc(100vh-32px)] overflow-auto">
            <div className="flex-1 flex flex-col px-4 sm:px-6 py-5 sm:py-8">
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
                Omitir →
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
                <StepAgent
                  businessId={businessId}
                  businessName={businessName}
                  onComplete={() => handleStepComplete(2)}
                  onSkip={handleSkipStep}
                />
              )}
            </motion.div>

            <div className="flex justify-between items-center mt-4 sm:mt-6 pb-2">
              <button
                onClick={handleSkipStep}
                className="text-gray-400 hover:text-white transition text-xs sm:text-sm"
              >
                {currentStep === 2 ? 'Terminar despues' : 'Saltar paso'}
              </button>
              
              <div className="text-gray-500 text-xs sm:text-sm">
                {currentStep} / {STEPS.length}
              </div>
            </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
