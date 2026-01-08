'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useBusinessStore } from '@/store/business';
import { messageApi, waApi, mediaApi, templatesApi } from '@/lib/api';
import { ArrowLeft, Send, Paperclip, Mic, User, Bot, Image as ImageIcon, Video, FileText, Check, CheckCheck, Clock, X, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface Message {
  id: string;
  direction: string;
  sender?: string;
  recipient?: string;
  message?: string;
  mediaUrl?: string;
  createdAt: string;
  metadata?: {
    mediaAnalysis?: string;
    mediaType?: string;
    type?: string;
    pending?: boolean;
    deliveryStatus?: string;
  };
}

interface WhatsAppInstance {
  id: string;
  instanceNumber: number;
  name: string;
  provider: string;
  phoneNumber: string | null;
  status: string;
}

interface WindowStatus {
  provider: string | null;
  requiresTemplate: boolean;
  windowOpen: boolean;
  hoursRemaining?: number;
  message: string;
}

export default function ChatPage() {
  const router = useRouter();
  const params = useParams();
  const instanceNumber = parseInt(params.instanceNumber as string, 10);
  const conversationId = params.conversationId as string;
  const { currentBusiness } = useBusinessStore();
  
  const [instance, setInstance] = useState<WhatsAppInstance | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contactName, setContactName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [windowStatus, setWindowStatus] = useState<WindowStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (currentBusiness?.id && instanceNumber && conversationId) {
      loadInstanceAndMessages();
      startPolling();
    }
    
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [currentBusiness?.id, instanceNumber, conversationId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadInstanceAndMessages = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      
      const instancesResponse = await waApi.instances(currentBusiness.id);
      const foundInstance = instancesResponse.data?.find(
        (i: WhatsAppInstance) => i.instanceNumber === instanceNumber
      );
      
      if (!foundInstance) {
        router.push('/dashboard/chats');
        return;
      }
      
      setInstance(foundInstance);
      
      const [messagesRes, windowRes] = await Promise.all([
        messageApi.conversation(currentBusiness.id, conversationId, foundInstance.id),
        messageApi.windowStatus(currentBusiness.id, conversationId).catch(() => null)
      ]);
      
      const messagesData = messagesRes.data || [];
      setMessages(messagesData);
      
      if (messagesData.length > 0) {
        const firstInbound = messagesData.find((m: Message) => m.direction === 'inbound');
        if (firstInbound?.metadata?.pushName) {
          setContactName(firstInbound.metadata.pushName);
        }
      }
      
      if (windowRes?.data) {
        setWindowStatus(windowRes.data);
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const startPolling = () => {
    pollingRef.current = setInterval(async () => {
      if (!currentBusiness?.id || !instance?.id) return;
      
      try {
        const res = await messageApi.conversation(currentBusiness.id, conversationId, instance.id);
        setMessages(res.data || []);
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 5000);
  };

  const handleSend = async () => {
    if (!newMessage.trim() || !currentBusiness?.id || sending) return;
    
    try {
      setSending(true);
      
      const tempMessage: Message = {
        id: `temp-${Date.now()}`,
        direction: 'outbound',
        message: newMessage,
        createdAt: new Date().toISOString(),
        metadata: { pending: true }
      };
      
      setMessages(prev => [...prev, tempMessage]);
      setNewMessage('');
      
      await messageApi.send(currentBusiness.id, conversationId, newMessage);
      
      setTimeout(async () => {
        const res = await messageApi.conversation(currentBusiness.id, conversationId, instance?.id);
        setMessages(res.data || []);
      }, 1000);
    } catch (error: any) {
      console.error('Send error:', error);
      setMessages(prev => prev.filter(m => !m.id.startsWith('temp-')));
    } finally {
      setSending(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentBusiness?.id) return;
    
    try {
      setUploading(true);
      const res = await mediaApi.upload(currentBusiness.id, file);
      
      if (res.data?.url) {
        await messageApi.send(currentBusiness.id, conversationId, res.data.url);
        setTimeout(async () => {
          const messagesRes = await messageApi.conversation(currentBusiness.id, conversationId, instance?.id);
          setMessages(messagesRes.data || []);
        }, 1000);
      }
    } catch (error) {
      console.error('Upload error:', error);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const renderMedia = (msg: Message) => {
    if (!msg.mediaUrl) return null;
    
    const mediaType = msg.metadata?.mediaType || msg.metadata?.type || '';
    
    if (mediaType.includes('image') || msg.mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      return (
        <img 
          src={msg.mediaUrl} 
          alt="Media" 
          className="max-w-xs rounded-lg cursor-pointer hover:opacity-90"
          onClick={() => window.open(msg.mediaUrl, '_blank')}
        />
      );
    }
    
    if (mediaType.includes('video') || msg.mediaUrl.match(/\.(mp4|webm|mov)$/i)) {
      return (
        <video 
          src={msg.mediaUrl} 
          controls 
          className="max-w-xs rounded-lg"
        />
      );
    }
    
    if (mediaType.includes('audio') || msg.mediaUrl.match(/\.(mp3|ogg|wav|m4a)$/i)) {
      return (
        <audio src={msg.mediaUrl} controls className="max-w-xs" />
      );
    }
    
    return (
      <a 
        href={msg.mediaUrl} 
        target="_blank" 
        rel="noopener noreferrer"
        className="flex items-center gap-2 text-cyan-400 hover:underline"
      >
        <FileText className="w-4 h-4" />
        Ver archivo
      </a>
    );
  };

  if (!currentBusiness) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400">Selecciona un negocio</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-900">
      <div className="p-4 border-b border-gray-700 flex items-center gap-4">
        <button 
          onClick={() => router.push(`/dashboard/chats/${instanceNumber}`)}
          className="p-2 hover:bg-gray-700 rounded-lg transition"
        >
          <ArrowLeft className="w-5 h-5 text-gray-400" />
        </button>
        
        <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
          <User className="w-5 h-5 text-gray-400" />
        </div>
        
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-white">
            {contactName || conversationId}
          </h1>
          <p className="text-sm text-gray-400">
            {instance?.name} ({instance?.phoneNumber})
          </p>
        </div>
        
        {windowStatus && (
          <div className={`px-3 py-1 rounded-full text-xs ${
            windowStatus.windowOpen 
              ? 'bg-green-500/20 text-green-400' 
              : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {windowStatus.windowOpen ? 'Ventana abierta' : 'Requiere template'}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <Bot className="w-12 h-12 mb-4 opacity-50" />
            <p>No hay mensajes en esta conversacion</p>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                  msg.direction === 'outbound'
                    ? 'bg-cyan-600 text-white rounded-br-md'
                    : 'bg-gray-700 text-white rounded-bl-md'
                } ${msg.metadata?.pending ? 'opacity-60' : ''}`}>
                  {msg.mediaUrl && (
                    <div className="mb-2">
                      {renderMedia(msg)}
                    </div>
                  )}
                  
                  {msg.message && (
                    <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                  )}
                  
                  <div className="flex items-center justify-end gap-1 mt-1 text-xs opacity-70">
                    <span>
                      {format(new Date(msg.createdAt), 'HH:mm', { locale: es })}
                    </span>
                    {msg.direction === 'outbound' && (
                      msg.metadata?.pending ? (
                        <Clock className="w-3 h-3" />
                      ) : msg.metadata?.deliveryStatus === 'read' ? (
                        <CheckCheck className="w-3 h-3 text-blue-400" />
                      ) : (
                        <Check className="w-3 h-3" />
                      )
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <div className="p-4 border-t border-gray-700">
        {windowStatus && !windowStatus.windowOpen && (
          <div className="mb-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-center gap-2 text-yellow-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{windowStatus.message}</span>
          </div>
        )}
        
        <div className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
          />
          
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="p-3 rounded-full hover:bg-gray-700 transition disabled:opacity-50"
          >
            <Paperclip className="w-5 h-5 text-gray-400" />
          </button>
          
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Escribe un mensaje..."
            className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-full text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          />
          
          <button
            onClick={handleSend}
            disabled={!newMessage.trim() || sending}
            className="p-3 rounded-full bg-cyan-600 hover:bg-cyan-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
