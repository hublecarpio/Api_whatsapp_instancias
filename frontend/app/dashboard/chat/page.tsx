'use client';

import { useState, useEffect, useRef } from 'react';
import { useBusinessStore } from '@/store/business';
import { messageApi, waApi, mediaApi, businessApi } from '@/lib/api';

interface Conversation {
  phone: string;
  contactName: string;
  lastMessage: string | null;
  lastMessageAt: string;
  messageCount: number;
}

interface Message {
  id: string;
  direction: string;
  sender?: string;
  recipient?: string;
  message?: string;
  mediaUrl?: string;
  createdAt: string;
}

export default function ChatPage() {
  const { currentBusiness } = useBusinessStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [selectedContactName, setSelectedContactName] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ file: File; url: string; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [botToggling, setBotToggling] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (currentBusiness) {
      fetchConversations();
      const interval = setInterval(fetchConversations, 10000);
      return () => clearInterval(interval);
    }
  }, [currentBusiness]);

  useEffect(() => {
    if (selectedPhone && currentBusiness) {
      fetchMessages(selectedPhone);
      const interval = setInterval(() => fetchMessages(selectedPhone), 5000);
      return () => clearInterval(interval);
    }
  }, [selectedPhone, currentBusiness]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchConversations = async () => {
    if (!currentBusiness) return;
    
    try {
      const response = await messageApi.conversations(currentBusiness.id);
      setConversations(response.data);
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchMessages = async (phone: string) => {
    if (!currentBusiness) return;
    
    try {
      const response = await messageApi.conversation(currentBusiness.id, phone);
      setMessages(response.data);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBusiness || !selectedPhone || (!newMessage.trim() && !previewFile)) return;

    setSending(true);
    setError(null);

    try {
      if (previewFile) {
        setUploading(true);
        const uploadRes = await mediaApi.upload(currentBusiness.id, previewFile.file);
        const { url, type } = uploadRes.data;
        
        const sendData: any = { to: selectedPhone };
        if (type === 'image') {
          sendData.imageUrl = url;
          sendData.message = newMessage || undefined;
        } else if (type === 'video') {
          sendData.videoUrl = url;
          sendData.message = newMessage || undefined;
        } else if (type === 'audio') {
          sendData.audioUrl = url;
        } else {
          sendData.fileUrl = url;
          sendData.fileName = previewFile.file.name;
        }
        
        await waApi.send(currentBusiness.id, sendData);
        setPreviewFile(null);
        setUploading(false);
      } else {
        await waApi.send(currentBusiness.id, {
          to: selectedPhone,
          message: newMessage
        });
      }
      
      setNewMessage('');
      fetchMessages(selectedPhone);
    } catch (err: any) {
      console.error('Failed to send message:', err);
      setError(err.response?.data?.error || 'Error al enviar mensaje');
      setTimeout(() => setError(null), 5000);
    } finally {
      setSending(false);
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const url = URL.createObjectURL(file);
    let type = 'file';
    if (file.type.startsWith('image/')) type = 'image';
    else if (file.type.startsWith('video/')) type = 'video';
    else if (file.type.startsWith('audio/')) type = 'audio';
    
    setPreviewFile({ file, url, type });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const cancelPreview = () => {
    if (previewFile) {
      URL.revokeObjectURL(previewFile.url);
      setPreviewFile(null);
    }
  };

  const handleToggleBot = async () => {
    if (!currentBusiness) return;
    setBotToggling(true);
    try {
      await businessApi.toggleBot(currentBusiness.id, !currentBusiness.botEnabled);
      const response = await businessApi.get(currentBusiness.id);
      useBusinessStore.setState({ currentBusiness: response.data });
    } catch (err) {
      console.error('Failed to toggle bot:', err);
    } finally {
      setBotToggling(false);
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    
    if (date.toDateString() === today.toDateString()) {
      return formatTime(dateStr);
    }
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Ayer';
    }
    
    return date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
  };

  const isImageUrl = (url: string) => {
    return /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url);
  };

  const isVideoUrl = (url: string) => {
    return /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(url);
  };

  const renderMedia = (mediaUrl: string, isOutbound: boolean) => {
    if (isImageUrl(mediaUrl)) {
      return (
        <div className="mb-2">
          <img 
            src={mediaUrl} 
            alt="Media" 
            className="max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
            style={{ maxHeight: '300px' }}
            onClick={() => window.open(mediaUrl, '_blank')}
          />
        </div>
      );
    }
    
    if (isVideoUrl(mediaUrl)) {
      return (
        <div className="mb-2">
          <video 
            src={mediaUrl} 
            controls 
            className="max-w-full rounded-lg"
            style={{ maxHeight: '300px' }}
          />
        </div>
      );
    }
    
    return (
      <a
        href={mediaUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-2 p-2 rounded-lg mb-2 ${
          isOutbound ? 'bg-green-700/30' : 'bg-gray-100'
        }`}
      >
        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
        <span className="text-sm underline">Ver archivo</span>
      </a>
    );
  };

  if (!currentBusiness) {
    return (
      <div className="h-[calc(100vh-8rem)] flex items-center justify-center">
        <div className="text-center text-gray-500">
          <p>Primero debes crear una empresa para ver conversaciones.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col">
      <div className="flex-1 flex overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div 
          className={`${sidebarOpen ? 'w-80' : 'w-0'} transition-all duration-300 overflow-hidden border-r border-gray-200 flex flex-col bg-white`}
        >
          <div className="p-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Chats</h2>
            <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">
              {conversations.length}
            </span>
          </div>
          
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-green-600 mx-auto"></div>
              </div>
            ) : conversations.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">
                <div className="w-16 h-16 mx-auto mb-3 bg-gray-100 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                No hay conversaciones
              </div>
            ) : (
              conversations.map((conv) => (
                <button
                  key={conv.phone}
                  onClick={() => {
                    setSelectedPhone(conv.phone);
                    setSelectedContactName(conv.contactName || '');
                  }}
                  className={`w-full p-3 text-left hover:bg-gray-50 transition-colors flex items-center gap-3 ${
                    selectedPhone === conv.phone ? 'bg-green-50 border-l-4 border-green-500' : ''
                  }`}
                >
                  <div className="w-12 h-12 bg-gradient-to-br from-gray-200 to-gray-300 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-xl">👤</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-gray-900 truncate text-sm">
                        {conv.contactName || `+${conv.phone}`}
                      </p>
                      <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
                        {formatDate(conv.lastMessageAt)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 truncate mt-0.5">
                      {conv.lastMessage || 'Sin mensajes'}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          {selectedPhone ? (
            <>
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
                <button
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors opacity-60 hover:opacity-100"
                  title={sidebarOpen ? 'Ocultar chats' : 'Mostrar chats'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {sidebarOpen ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                    )}
                  </svg>
                </button>
                
                <div className="w-10 h-10 bg-gradient-to-br from-green-400 to-green-600 rounded-full flex items-center justify-center">
                  <span className="text-white text-lg">👤</span>
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">
                    {selectedContactName || `+${selectedPhone}`}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    {selectedContactName && <span>+{selectedPhone}</span>}
                    <button
                      onClick={handleToggleBot}
                      disabled={botToggling}
                      className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                        currentBusiness.botEnabled 
                          ? 'bg-green-100 text-green-700 hover:bg-green-200' 
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      } disabled:opacity-50`}
                      title="Click para cambiar el estado del bot"
                    >
                      {currentBusiness.botEnabled ? '🤖 Bot activo' : '😴 Bot inactivo'}
                    </button>
                  </div>
                </div>
              </div>

              <div 
                className="flex-1 overflow-y-auto p-4 space-y-2"
                style={{ 
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23e5e7eb\' fill-opacity=\'0.4\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")',
                  backgroundColor: '#f0f2f5'
                }}
              >
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl px-4 py-2 shadow-sm ${
                        msg.direction === 'outbound'
                          ? 'bg-green-500 text-white rounded-br-md'
                          : 'bg-white text-gray-900 rounded-bl-md'
                      }`}
                    >
                      {msg.mediaUrl && renderMedia(msg.mediaUrl, msg.direction === 'outbound')}
                      {msg.message && (
                        <p className="break-words whitespace-pre-wrap">{msg.message}</p>
                      )}
                      <p
                        className={`text-xs mt-1 text-right ${
                          msg.direction === 'outbound' ? 'text-green-100' : 'text-gray-400'
                        }`}
                      >
                        {formatTime(msg.createdAt)}
                        {msg.direction === 'outbound' && (
                          <span className="ml-1">✓✓</span>
                        )}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {previewFile && (
                <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                  <div className="flex items-center gap-3 p-2 bg-white rounded-lg border border-gray-200">
                    {previewFile.type === 'image' ? (
                      <img src={previewFile.url} alt="Preview" className="w-16 h-16 object-cover rounded" />
                    ) : previewFile.type === 'video' ? (
                      <video src={previewFile.url} className="w-16 h-16 object-cover rounded" />
                    ) : (
                      <div className="w-16 h-16 bg-gray-100 rounded flex items-center justify-center">
                        <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">{previewFile.file.name}</p>
                      <p className="text-xs text-gray-500">
                        {(previewFile.file.size / 1024).toFixed(1)} KB
                      </p>
                    </div>
                    <button
                      onClick={cancelPreview}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="mx-3 mb-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSend} className="p-3 border-t border-gray-100 bg-gray-50">
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar"
                  />
                  <input
                    type="file"
                    ref={audioInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="audio/*"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="p-2.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-full transition-colors"
                    disabled={sending}
                    title="Adjuntar archivo"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={() => audioInputRef.current?.click()}
                    className="p-2.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-full transition-colors"
                    disabled={sending}
                    title="Enviar audio"
                  >
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3z"/>
                      <path d="M17 16.91c-.49.97-1.25 1.81-2.17 2.41.96.26 1.98.4 3.04.4 2.21 0 4.35-.72 6.07-2.04l-2.21-2.21c-1.43 1.23-3.3 1.95-5.37 1.95-.27 0-.54-.03-.81-.06.53-.99.83-2.11.83-3.31 0-.56-.05-1.11-.14-1.64 2.25-1.27 3.75-3.78 3.75-6.6 0-4.14-3.36-7.5-7.5-7.5S4.5 4.86 4.5 9c0 2.82 1.5 5.33 3.75 6.6-.09.53-.14 1.08-.14 1.64 0 1.2.3 2.32.83 3.31-.27.03-.54.06-.81.06-2.07 0-3.94-.72-5.37-1.95L.79 19.8c1.72 1.32 3.86 2.04 6.04 2.04 1.06 0 2.08-.14 3.04-.4-.92-.6-1.68-1.44-2.17-2.41H17z"/>
                    </svg>
                  </button>
                  
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      placeholder="Escribe un mensaje..."
                      className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-full focus:outline-none focus:border-green-400 focus:ring-2 focus:ring-green-100 transition-all"
                      disabled={sending}
                    />
                  </div>
                  
                  <button
                    type="submit"
                    disabled={sending || (!newMessage.trim() && !previewFile)}
                    className="p-2.5 bg-green-500 text-white rounded-full hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    title="Enviar"
                  >
                    {sending ? (
                      <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                    )}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400 bg-gray-50">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="absolute left-4 top-4 p-2 hover:bg-gray-200 rounded-lg transition-colors lg:hidden"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              
              <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <svg className="w-12 h-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="text-lg font-medium text-gray-500">WhatsApp SaaS</p>
              <p className="text-sm mt-1">Selecciona una conversacion para comenzar</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
