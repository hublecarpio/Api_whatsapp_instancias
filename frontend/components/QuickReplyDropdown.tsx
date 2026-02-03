'use client';

import { useState, useEffect, useRef } from 'react';
import { quickRepliesApi } from '@/lib/api';

interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  message: string;
  order: number;
}

interface QuickReplyDropdownProps {
  businessId: string;
  inputValue: string;
  onSelect: (message: string) => void;
  onClose: () => void;
  position?: 'top' | 'bottom';
}

export default function QuickReplyDropdown({
  businessId,
  inputValue,
  onSelect,
  onClose,
  position = 'top'
}: QuickReplyDropdownProps) {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const searchTerm = inputValue.startsWith('/') ? inputValue.slice(1).toLowerCase() : '';
  
  const filteredReplies = replies.filter(r => 
    r.shortcut.toLowerCase().includes(searchTerm) ||
    r.title.toLowerCase().includes(searchTerm)
  );

  useEffect(() => {
    const fetchReplies = async () => {
      try {
        const res = await quickRepliesApi.list(businessId);
        setReplies(res.data);
      } catch (err) {
        console.error('Failed to fetch quick replies:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchReplies();
  }, [businessId]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchTerm]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filteredReplies.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filteredReplies.length > 0) {
        e.preventDefault();
        onSelect(filteredReplies[selectedIndex].message);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [filteredReplies, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (loading) {
    return (
      <div 
        ref={dropdownRef}
        className={`absolute left-0 right-0 ${position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} bg-dark-card border border-dark-border rounded-lg shadow-lg p-3 z-50`}
      >
        <div className="flex items-center gap-2 text-gray-400">
          <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Cargando...</span>
        </div>
      </div>
    );
  }

  if (filteredReplies.length === 0) {
    return (
      <div 
        ref={dropdownRef}
        className={`absolute left-0 right-0 ${position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} bg-dark-card border border-dark-border rounded-lg shadow-lg p-4 z-50`}
      >
        <div className="text-center text-gray-400">
          <p className="text-sm">
            {replies.length === 0 ? 'No hay respuestas rápidas' : 'Sin resultados'}
          </p>
          {replies.length === 0 && (
            <p className="text-xs mt-1 text-gray-500">
              Crea respuestas con el botón de ajustes
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={dropdownRef}
      className={`absolute left-0 right-0 ${position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} bg-dark-card border border-dark-border rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto`}
    >
      <div className="px-3 py-2 border-b border-dark-border">
        <span className="text-xs text-gray-400">Respuestas Rápidas</span>
      </div>
      {filteredReplies.map((reply, index) => (
        <button
          key={reply.id}
          onClick={() => onSelect(reply.message)}
          onMouseEnter={() => setSelectedIndex(index)}
          className={`w-full px-3 py-2.5 text-left transition-colors ${
            index === selectedIndex 
              ? 'bg-neon-blue/20 border-l-2 border-neon-blue' 
              : 'hover:bg-dark-surface border-l-2 border-transparent'
          }`}
        >
          <div className="flex items-start gap-2">
            <span className="text-neon-blue font-mono text-sm flex-shrink-0">
              /{reply.shortcut}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{reply.title}</p>
              <p className="text-gray-400 text-xs truncate mt-0.5">{reply.message}</p>
            </div>
          </div>
        </button>
      ))}
      <div className="px-3 py-1.5 border-t border-dark-border bg-dark-surface/50">
        <span className="text-[10px] text-gray-500">
          <kbd className="px-1 py-0.5 bg-dark-bg rounded text-gray-400">↑↓</kbd> navegar
          <kbd className="ml-2 px-1 py-0.5 bg-dark-bg rounded text-gray-400">Enter</kbd> seleccionar
          <kbd className="ml-2 px-1 py-0.5 bg-dark-bg rounded text-gray-400">Esc</kbd> cerrar
        </span>
      </div>
    </div>
  );
}
