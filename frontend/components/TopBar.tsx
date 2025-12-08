'use client';

import Logo from './Logo';

interface TopBarProps {
  onMenuClick: () => void;
  title?: string;
}

export default function TopBar({ onMenuClick, title }: TopBarProps) {
  return (
    <header className="topbar">
      <button
        onClick={onMenuClick}
        className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-colors"
        aria-label="Abrir menu"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <Logo size="sm" showText={false} />

      <div className="w-10" />
    </header>
  );
}
