'use client';

import React from 'react';

interface IconProps {
  className?: string;
  size?: number;
}

const iconBaseClass = "transition-all duration-300 drop-shadow-[0_0_8px_rgba(0,212,255,0.6)]";

export const BusinessIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="50%" stopColor="#00A8CC" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
      <filter id="glow1">
        <feGaussianBlur stdDeviation="1" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <path d="M3 21V7l9-4 9 4v14H3z" stroke="url(#holoGrad1)" strokeWidth="1.5" fill="none" filter="url(#glow1)"/>
    <path d="M9 21V13h6v8" stroke="url(#holoGrad1)" strokeWidth="1.5" fill="none"/>
    <rect x="7" y="9" width="3" height="2" fill="url(#holoGrad1)" opacity="0.7"/>
    <rect x="14" y="9" width="3" height="2" fill="url(#holoGrad1)" opacity="0.7"/>
  </svg>
);

export const WhatsAppIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke="url(#holoGrad2)" strokeWidth="1.5" fill="none"/>
    <path d="M8 10h.01M12 10h.01M16 10h.01" stroke="url(#holoGrad2)" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

export const AgentIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <rect x="3" y="4" width="18" height="14" rx="3" stroke="url(#holoGrad3)" strokeWidth="1.5" fill="none"/>
    <circle cx="9" cy="11" r="2" stroke="url(#holoGrad3)" strokeWidth="1.5" fill="none"/>
    <circle cx="15" cy="11" r="2" stroke="url(#holoGrad3)" strokeWidth="1.5" fill="none"/>
    <path d="M8 18v2M16 18v2M10 18h4" stroke="url(#holoGrad3)" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M7 7h2M15 7h2" stroke="url(#holoGrad3)" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const TemplateIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad4" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="url(#holoGrad4)" strokeWidth="1.5" fill="none"/>
    <path d="M14 2v6h6" stroke="url(#holoGrad4)" strokeWidth="1.5" fill="none"/>
    <path d="M8 13h8M8 17h5" stroke="url(#holoGrad4)" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const ProductsIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad5" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" stroke="url(#holoGrad5)" strokeWidth="1.5" fill="none"/>
    <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" stroke="url(#holoGrad5)" strokeWidth="1.5"/>
  </svg>
);

export const OrdersIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad6" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <circle cx="9" cy="21" r="1" stroke="url(#holoGrad6)" strokeWidth="1.5" fill="none"/>
    <circle cx="20" cy="21" r="1" stroke="url(#holoGrad6)" strokeWidth="1.5" fill="none"/>
    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" stroke="url(#holoGrad6)" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const AppointmentsIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad7" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <rect x="3" y="4" width="18" height="18" rx="2" stroke="url(#holoGrad7)" strokeWidth="1.5" fill="none"/>
    <path d="M16 2v4M8 2v4M3 10h18" stroke="url(#holoGrad7)" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="12" cy="16" r="2" stroke="url(#holoGrad7)" strokeWidth="1.5" fill="none"/>
  </svg>
);

export const ExtractionIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad8" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="url(#holoGrad8)" strokeWidth="1.5" fill="none"/>
    <path d="M14 2v6h6" stroke="url(#holoGrad8)" strokeWidth="1.5" fill="none"/>
    <path d="M8 13l2 2 4-4" stroke="url(#holoGrad8)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8 18h8" stroke="url(#holoGrad8)" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const ContactsIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad9" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <circle cx="9" cy="7" r="4" stroke="url(#holoGrad9)" strokeWidth="1.5" fill="none"/>
    <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" stroke="url(#holoGrad9)" strokeWidth="1.5"/>
    <circle cx="17" cy="7" r="3" stroke="url(#holoGrad9)" strokeWidth="1.5" fill="none" opacity="0.6"/>
    <path d="M21 21v-2a3 3 0 0 0-2-2.83" stroke="url(#holoGrad9)" strokeWidth="1.5" opacity="0.6"/>
  </svg>
);

export const ChatIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad10" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" stroke="url(#holoGrad10)" strokeWidth="1.5" fill="none"/>
    <path d="M8 10h.01M12 10h.01M16 10h.01" stroke="url(#holoGrad10)" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

export const BroadcastIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad11" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M12 18.5A2.5 2.5 0 1 0 12 23.5a2.5 2.5 0 0 0 0-5z" stroke="url(#holoGrad11)" strokeWidth="1.5" fill="none"/>
    <path d="M12 2v8" stroke="url(#holoGrad11)" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M4.93 10.93l2.83 2.83M19.07 10.93l-2.83 2.83" stroke="url(#holoGrad11)" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M2 18h4M18 18h4" stroke="url(#holoGrad11)" strokeWidth="1.5" strokeLinecap="round"/>
    <polygon points="12,2 8,10 16,10" stroke="url(#holoGrad11)" strokeWidth="1.5" fill="none"/>
  </svg>
);

export const TagsIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad12" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" stroke="url(#holoGrad12)" strokeWidth="1.5" fill="none"/>
    <circle cx="7" cy="7" r="1.5" fill="url(#holoGrad12)"/>
  </svg>
);

export const RemindersIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad13" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <circle cx="12" cy="12" r="10" stroke="url(#holoGrad13)" strokeWidth="1.5" fill="none"/>
    <path d="M12 6v6l4 2" stroke="url(#holoGrad13)" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M5 3L3 5M21 5l-2-2" stroke="url(#holoGrad13)" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const ApiIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad14" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <path d="M18 8h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" stroke="url(#holoGrad14)" strokeWidth="1.5" fill="none"/>
    <path d="M6 8H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" stroke="url(#holoGrad14)" strokeWidth="1.5" fill="none"/>
    <rect x="6" y="2" width="12" height="20" rx="2" stroke="url(#holoGrad14)" strokeWidth="1.5" fill="none"/>
    <circle cx="12" cy="8" r="2" stroke="url(#holoGrad14)" strokeWidth="1.5" fill="none"/>
    <path d="M10 14h4M9 17h6" stroke="url(#holoGrad14)" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const BillingIcon: React.FC<IconProps> = ({ className = "", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`${iconBaseClass} ${className}`}>
    <defs>
      <linearGradient id="holoGrad15" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#00D4FF" />
        <stop offset="100%" stopColor="#0077B6" />
      </linearGradient>
    </defs>
    <rect x="2" y="4" width="20" height="16" rx="2" stroke="url(#holoGrad15)" strokeWidth="1.5" fill="none"/>
    <path d="M2 10h20" stroke="url(#holoGrad15)" strokeWidth="1.5"/>
    <path d="M6 16h4M14 16h4" stroke="url(#holoGrad15)" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="17" cy="7" r="1" fill="url(#holoGrad15)" opacity="0.7"/>
  </svg>
);

export const iconMap: Record<string, React.FC<IconProps>> = {
  '🏢': BusinessIcon,
  '💬': WhatsAppIcon,
  '🤖': AgentIcon,
  '📄': TemplateIcon,
  '📦': ProductsIcon,
  '🛒': OrdersIcon,
  '📅': AppointmentsIcon,
  '📝': ExtractionIcon,
  '👥': ContactsIcon,
  '💭': ChatIcon,
  '📢': BroadcastIcon,
  '🏷️': TagsIcon,
  '⏰': RemindersIcon,
  '🔌': ApiIcon,
  '💳': BillingIcon,
};

export const HoloIcon: React.FC<IconProps & { emoji: string }> = ({ emoji, ...props }) => {
  const IconComponent = iconMap[emoji];
  if (IconComponent) {
    return <IconComponent {...props} />;
  }
  return <span className="text-xl">{emoji}</span>;
};

export default HoloIcon;
