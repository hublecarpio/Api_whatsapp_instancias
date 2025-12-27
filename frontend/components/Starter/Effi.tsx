'use client';

import { motion } from 'framer-motion';
import { useMemo } from 'react';

interface EffiProps {
  message: string;
  mood?: 'happy' | 'thinking' | 'celebrating';
  compact?: boolean;
}

interface Node {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
}

export default function Effi({ message, mood = 'happy', compact = false }: EffiProps) {
  const size = compact ? 60 : 80;
  
  const nodes = useMemo<Node[]>(() => [
    { id: 0, x: 40, y: 40, size: 12, delay: 0 },
    { id: 1, x: 20, y: 25, size: 6, delay: 0.1 },
    { id: 2, x: 60, y: 25, size: 6, delay: 0.2 },
    { id: 3, x: 15, y: 50, size: 5, delay: 0.3 },
    { id: 4, x: 65, y: 50, size: 5, delay: 0.4 },
    { id: 5, x: 25, y: 65, size: 4, delay: 0.5 },
    { id: 6, x: 55, y: 65, size: 4, delay: 0.6 },
    { id: 7, x: 40, y: 15, size: 5, delay: 0.7 },
  ], []);

  const connections = useMemo(() => [
    [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7],
    [1, 2], [1, 3], [2, 4], [3, 5], [4, 6], [1, 7], [2, 7],
    [5, 6]
  ], []);

  const floatAnimation = {
    y: [0, -8, 0],
    transition: {
      duration: 3,
      repeat: Infinity,
      ease: "easeInOut" as const
    }
  };

  const pulseAnimation = {
    scale: [1, 1.15, 1],
    opacity: [0.8, 1, 0.8],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: "easeInOut" as const
    }
  };

  const nodeWaveAnimation = (delay: number) => ({
    y: [0, -3, 0, 3, 0],
    x: [0, 2, 0, -2, 0],
    transition: {
      duration: 4,
      repeat: Infinity,
      ease: "easeInOut" as const,
      delay
    }
  });

  const glowColor = mood === 'celebrating' ? '#FFD700' : mood === 'thinking' ? '#8B5CF6' : '#22D3EE';
  const nodeColor = mood === 'celebrating' ? '#FCD34D' : mood === 'thinking' ? '#A78BFA' : '#67E8F9';
  const coreColor = mood === 'celebrating' ? '#F59E0B' : mood === 'thinking' ? '#7C3AED' : '#06B6D4';

  return (
    <div className={`flex items-end ${compact ? 'gap-2 sm:gap-3' : 'gap-4'}`}>
      <motion.div
        animate={floatAnimation}
        className="relative flex-shrink-0"
        style={{ filter: `drop-shadow(0 0 10px ${glowColor}40)` }}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 80 80"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="overflow-visible"
        >
          <defs>
            <radialGradient id="coreGradient" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={nodeColor} />
              <stop offset="100%" stopColor={coreColor} />
            </radialGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
            <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={nodeColor} stopOpacity="0.3" />
              <stop offset="50%" stopColor={nodeColor} stopOpacity="0.6" />
              <stop offset="100%" stopColor={nodeColor} stopOpacity="0.3" />
            </linearGradient>
          </defs>

          {connections.map(([from, to], index) => {
            const fromNode = nodes[from];
            const toNode = nodes[to];
            return (
              <motion.line
                key={`connection-${index}`}
                x1={fromNode.x}
                y1={fromNode.y}
                x2={toNode.x}
                y2={toNode.y}
                stroke="url(#lineGradient)"
                strokeWidth="1"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ 
                  pathLength: 1, 
                  opacity: [0.3, 0.6, 0.3],
                }}
                transition={{
                  pathLength: { duration: 1, delay: index * 0.05 },
                  opacity: { duration: 2, repeat: Infinity, delay: index * 0.1 }
                }}
              />
            );
          })}

          {nodes.slice(1).map((node) => (
            <motion.g key={node.id} animate={nodeWaveAnimation(node.delay)}>
              <motion.circle
                cx={node.x}
                cy={node.y}
                r={node.size}
                fill={nodeColor}
                opacity="0.8"
                filter="url(#glow)"
                animate={{
                  r: [node.size, node.size * 1.2, node.size],
                  opacity: [0.6, 0.9, 0.6]
                }}
                transition={{
                  duration: 2 + node.delay,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: node.delay
                }}
              />
              <circle
                cx={node.x}
                cy={node.y}
                r={node.size * 0.4}
                fill="white"
                opacity="0.8"
              />
            </motion.g>
          ))}

          <motion.g animate={pulseAnimation}>
            <circle
              cx={40}
              cy={40}
              r={16}
              fill="url(#coreGradient)"
              filter="url(#glow)"
            />
            <circle
              cx={40}
              cy={40}
              r={8}
              fill="white"
              opacity="0.9"
            />
            <motion.circle
              cx={40}
              cy={40}
              r={20}
              fill="none"
              stroke={nodeColor}
              strokeWidth="1"
              opacity="0.4"
              animate={{
                r: [20, 28, 20],
                opacity: [0.4, 0.1, 0.4]
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeOut"
              }}
            />
          </motion.g>

          {mood === 'celebrating' && (
            <>
              <motion.circle
                cx={25}
                cy={20}
                r={3}
                fill="#FFD700"
                animate={{
                  y: [0, -15, 0],
                  opacity: [0, 1, 0],
                  scale: [0.5, 1.2, 0.5]
                }}
                transition={{ duration: 1.5, repeat: Infinity, delay: 0 }}
              />
              <motion.circle
                cx={55}
                cy={18}
                r={2}
                fill="#F59E0B"
                animate={{
                  y: [0, -12, 0],
                  opacity: [0, 1, 0],
                  scale: [0.5, 1, 0.5]
                }}
                transition={{ duration: 1.2, repeat: Infinity, delay: 0.3 }}
              />
              <motion.circle
                cx={40}
                cy={12}
                r={2.5}
                fill="#FBBF24"
                animate={{
                  y: [0, -18, 0],
                  opacity: [0, 1, 0],
                  scale: [0.5, 1.1, 0.5]
                }}
                transition={{ duration: 1.8, repeat: Infinity, delay: 0.6 }}
              />
            </>
          )}
        </svg>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, x: -10, scale: 0.9 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        transition={{ delay: 0.2 }}
        className={`relative bg-[#1a1a2e]/90 backdrop-blur-sm border border-cyan-500/30 rounded-2xl rounded-bl-none shadow-lg shadow-cyan-500/10 ${
          compact ? 'px-3 py-2 max-w-[200px] sm:max-w-xs' : 'px-4 py-3 max-w-xs'
        }`}
      >
        <p className={`text-white leading-relaxed ${compact ? 'text-xs sm:text-sm' : 'text-sm'}`}>{message}</p>
        <div className="absolute -bottom-2 left-0 w-3 h-3 bg-[#1a1a2e]/90 border-l border-b border-cyan-500/30 transform rotate-[-45deg]" />
      </motion.div>
    </div>
  );
}
