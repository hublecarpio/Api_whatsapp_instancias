'use client';

import { motion } from 'framer-motion';

interface EffiProps {
  message: string;
  mood?: 'happy' | 'thinking' | 'celebrating';
  compact?: boolean;
}

export default function Effi({ message, mood = 'happy', compact = false }: EffiProps) {
  const eyeAnimation = {
    blink: {
      scaleY: [1, 0.1, 1],
      transition: { duration: 0.15, repeat: Infinity, repeatDelay: 3 }
    }
  };

  const bodyBounce = {
    bounce: {
      y: [0, -5, 0],
      transition: { duration: 0.6, repeat: Infinity, ease: "easeInOut" as const }
    }
  };

  const size = compact ? 60 : 80;

  return (
    <div className={`flex items-end ${compact ? 'gap-2 sm:gap-3' : 'gap-4'}`}>
      <motion.div
        animate="bounce"
        variants={bodyBounce}
        className="relative flex-shrink-0"
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 80 80"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="40" cy="45" r="30" fill="#25D366" />
          
          <ellipse cx="40" cy="75" rx="20" ry="5" fill="rgba(0,0,0,0.1)" />
          
          <motion.ellipse
            cx="30"
            cy="42"
            rx="5"
            ry="6"
            fill="white"
            animate="blink"
            variants={eyeAnimation}
          />
          <motion.ellipse
            cx="50"
            cy="42"
            rx="5"
            ry="6"
            fill="white"
            animate="blink"
            variants={eyeAnimation}
          />
          <circle cx="30" cy="43" r="2.5" fill="#1a1a2e" />
          <circle cx="50" cy="43" r="2.5" fill="#1a1a2e" />
          
          {mood === 'happy' && (
            <path
              d="M32 54 Q40 62 48 54"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          )}
          {mood === 'thinking' && (
            <ellipse cx="40" cy="56" rx="4" ry="3" fill="white" />
          )}
          {mood === 'celebrating' && (
            <>
              <path
                d="M30 52 Q40 65 50 52"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                fill="none"
              />
              <motion.text
                x="60"
                y="25"
                fontSize="16"
                animate={{ rotate: [0, 15, -15, 0], y: [0, -3, 0] }}
                transition={{ duration: 0.5, repeat: Infinity }}
              >
                🎉
              </motion.text>
            </>
          )}
          
          <ellipse cx="20" cy="50" rx="4" ry="3" fill="#1DBF5B" />
          <ellipse cx="60" cy="50" rx="4" ry="3" fill="#1DBF5B" />
        </svg>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, x: -10, scale: 0.9 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        transition={{ delay: 0.2 }}
        className={`relative bg-[#1a1a2e] border border-gray-700 rounded-2xl rounded-bl-none shadow-lg ${
          compact ? 'px-3 py-2 max-w-[200px] sm:max-w-xs' : 'px-4 py-3 max-w-xs'
        }`}
      >
        <p className={`text-white leading-relaxed ${compact ? 'text-xs sm:text-sm' : 'text-sm'}`}>{message}</p>
        <div className="absolute -bottom-2 left-0 w-3 h-3 bg-[#1a1a2e] border-l border-b border-gray-700 transform rotate-[-45deg]" />
      </motion.div>
    </div>
  );
}
