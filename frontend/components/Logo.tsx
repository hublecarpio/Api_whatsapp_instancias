'use client';

import { useBranding } from './GlassProvider';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
}

export default function Logo({ size = 'md', showText = true }: LogoProps) {
  const branding = useBranding();
  
  const sizes = {
    sm: { icon: 24, text: 'text-lg' },
    md: { icon: 32, text: 'text-xl' },
    lg: { icon: 40, text: 'text-2xl' }
  };

  const { icon, text } = sizes[size];

  if (branding.logoUrl) {
    return (
      <div className="flex items-center gap-2">
        <img 
          src={branding.logoUrl} 
          alt={branding.appName} 
          style={{ height: icon }}
          className="object-contain"
        />
        {showText && (
          <span className={`font-bold ${text} text-white tracking-tight`}>
            {branding.appName}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <svg
          width={icon}
          height={icon}
          viewBox="0 0 40 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="drop-shadow-[0_0_8px_rgba(0,212,255,0.5)]"
          style={{ filter: `drop-shadow(0 0 8px ${branding.primaryColor}80)` }}
        >
          <rect
            x="2"
            y="2"
            width="36"
            height="36"
            rx="8"
            stroke={branding.primaryColor}
            strokeWidth="2.5"
            fill="transparent"
          />
          <path
            d="M12 14L20 20L12 26V14Z"
            fill={branding.primaryColor}
            style={{ filter: `drop-shadow(0 0 4px ${branding.primaryColor}CC)` }}
          />
          <path
            d="M20 14L28 20L20 26V14Z"
            fill={branding.primaryColor}
            fillOpacity="0.5"
          />
          <circle
            cx="20"
            cy="20"
            r="3"
            fill={branding.primaryColor}
            className="animate-pulse"
          />
        </svg>
        <div 
          className="absolute inset-0 blur-xl rounded-full -z-10" 
          style={{ backgroundColor: `${branding.primaryColor}33` }}
        />
      </div>
      {showText && (
        <span className={`font-bold ${text} text-white tracking-tight`}>
          {branding.appName}
        </span>
      )}
    </div>
  );
}
