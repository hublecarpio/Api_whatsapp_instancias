'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { advisorApi, messageApi, mediaApi, waApi } from '@/lib/api';
import Logo from '@/components/Logo';

interface Business {
  id: string;
  name: string;
  description: string;
  businessObjective: string;
  assignedContactsCount: number;
}

interface Conversation {
  phone: string;
  contactName: string;
  lastMessage: string | null;
  lastMessageAt: string;
  messageCount: number;
  unread: number;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  message: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  createdAt: string;
  metadata: any;
}

export default function AsesorPage() {
  const router = useRouter();
  const { user, token, logout, loadFromStorage } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState<Business | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [sending, setSending] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ file: File; url: string; type: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    loadFromStorage();
    setInitialized(true);
  }, [loadFromStorage]);

  useEffect(() => {
    if (!initialized) return;
    
    if (!token) {
      router.push('/login');
      return;
    }

    if (user?.role !== 'ASESOR') {
      router.push('/dashboard');
      return;
    }

    loadBusinesses();
  }, [initialized, token, user, router]);

  const loadBusinesses = async () => {
    try {
      const res = await advisorApi.getMyBusiness();
      setBusinesses(res.data);
      if (res.data.length > 0) {
        setSelectedBusiness(res.data[0]);
      }
    } catch (error) {
      console.error('Error loading businesses:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedBusiness) {
      loadConversations();
    }
  }, [selectedBusiness]);

  const loadConversations = async () => {
    if (!selectedBusiness) return;
    try {
      const res = await messageApi.conversations(selectedBusiness.id);
      setConversations(res.data);
    } catch (error) {
      console.error('Error loading conversations:', error);
    }
  };

  useEffect(() => {
    if (selectedConversation && selectedBusiness) {
      loadMessages();
    }
  }, [selectedConversation, selectedBusiness]);

  const loadMessages = async () => {
    if (!selectedConversation || !selectedBusiness) return;
    try {
      const res = await messageApi.conversation(selectedBusiness.id, selectedConversation.phone);
      setMessages(res.data);
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  useEffect(() => {
    if (!selectedConversation || !selectedBusiness) return;
    const interval = setInterval(loadMessages, 5000);
    return () => clearInterval(interval);
  }, [selectedConversation, selectedBusiness]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!messageInput.trim() && !previewFile) || !selectedConversation || !selectedBusiness || sending) return;

    const tempId = `temp-${Date.now()}`;
    const messageCopy = messageInput;
    const fileCopy = previewFile;

    const optimisticMessage: Message = {
      id: tempId,
      direction: 'outbound',
      message: fileCopy ? null : messageCopy,
      mediaUrl: fileCopy?.url || null,
      mediaType: fileCopy?.type || null,
      createdAt: new Date().toISOString(),
      metadata: { pending: true }
    };

    setMessages(prev => [...prev, optimisticMessage]);
    setMessageInput('');
    setSending(true);

    try {
      if (fileCopy) {
        setUploading(true);
        const uploadRes = await mediaApi.upload(selectedBusiness.id, fileCopy.file);
        const { url, type, mimetype } = uploadRes.data;
        
        const sendData: any = { to: selectedConversation.phone };
        if (type === 'image') {
          sendData.imageUrl = url;
          sendData.message = messageCopy || undefined;
        } else if (type === 'video') {
          sendData.videoUrl = url;
          sendData.message = messageCopy || undefined;
        } else if (type === 'audio') {
          sendData.audioUrl = url;
        } else {
          sendData.fileUrl = url;
          sendData.fileName = fileCopy.file.name;
          sendData.mimeType = mimetype || fileCopy.file.type;
        }
        
        await waApi.send(selectedBusiness.id, sendData);
        setPreviewFile(null);
        setUploading(false);
      } else {
        await messageApi.send(selectedBusiness.id, selectedConversation.phone, messageCopy);
      }
      await loadMessages();
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setMessageInput(messageCopy);
      if (fileCopy) setPreviewFile(fileCopy);
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

  const handleStartRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      const audioChunks: Blob[] = [];
      
      mediaRecorder.ondataavailable = (event) => audioChunks.push(event.data);
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const file = new File([audioBlob], 'audio.webm', { type: 'audio/webm' });
        setPreviewFile({ file, url: URL.createObjectURL(file), type: 'audio' });
        stream.getTracks().forEach(track => track.stop());
        setIsRecording(false);
      };
      
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-neon-blue border-t-transparent"></div>
      </div>
    );
  }

  if (businesses.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-bg p-4">
        <div className="max-w-md w-full card text-center py-10">
          <div className="w-16 h-16 bg-yellow-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-3">Sin asignaciones</h2>
          <p className="text-gray-400 mb-6">
            Aun no tienes contactos asignados. Contacta a tu administrador para que te asigne conversaciones.
          </p>
          <button onClick={handleLogout} className="btn btn-secondary">
            Cerrar sesion
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-bg flex flex-col">
      <header className="bg-dark-card border-b border-dark-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Logo size="sm" />
          <div className="h-6 w-px bg-dark-border"></div>
          <span className="text-sm text-gray-400">Panel de Asesor</span>
          {businesses.length > 1 && (
            <select
              value={selectedBusiness?.id || ''}
              onChange={(e) => {
                const biz = businesses.find(b => b.id === e.target.value);
                setSelectedBusiness(biz || null);
                setSelectedConversation(null);
                setMessages([]);
              }}
              className="input py-1 text-sm"
            >
              {businesses.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{user?.name}</span>
          <button onClick={handleLogout} className="btn btn-secondary btn-sm">
            Salir
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-80 bg-dark-card border-r border-dark-border flex flex-col">
          <div className="p-4 border-b border-dark-border">
            <h3 className="font-medium text-white">Conversaciones asignadas</h3>
            <p className="text-xs text-gray-500 mt-1">
              {conversations.length} contacto{conversations.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">
                No tienes conversaciones asignadas
              </div>
            ) : (
              conversations.map(conv => (
                <button
                  key={conv.phone}
                  onClick={() => setSelectedConversation(conv)}
                  className={`w-full text-left p-4 border-b border-dark-border hover:bg-dark-bg/50 transition-colors ${
                    selectedConversation?.phone === conv.phone ? 'bg-dark-bg/50' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-white truncate">
                        {conv.contactName || conv.phone}
                      </p>
                      {conv.contactName && (
                        <p className="text-xs text-gray-500">{conv.phone}</p>
                      )}
                      {conv.lastMessage && (
                        <p className="text-sm text-gray-400 truncate mt-1">
                          {conv.lastMessage}
                        </p>
                      )}
                    </div>
                    {conv.unread > 0 && (
                      <span className="bg-neon-blue text-white text-xs rounded-full px-2 py-0.5 ml-2">
                        {conv.unread}
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          {!selectedConversation ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Selecciona una conversacion para empezar
            </div>
          ) : (
            <>
              <div className="bg-dark-card border-b border-dark-border px-4 py-3">
                <p className="font-medium text-white">
                  {selectedConversation.contactName || selectedConversation.phone}
                </p>
                {selectedConversation.contactName && (
                  <p className="text-xs text-gray-500">{selectedConversation.phone}</p>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-lg px-3 py-2 ${
                        msg.direction === 'outbound'
                          ? 'bg-neon-blue text-white'
                          : 'bg-dark-card text-white'
                      } ${msg.metadata?.pending ? 'opacity-70' : ''}`}
                    >
                      {msg.mediaUrl && (
                        <div className="mb-2">
                          {msg.mediaType?.startsWith('image') ? (
                            <img src={msg.mediaUrl} alt="Media" className="max-w-full rounded" />
                          ) : msg.mediaType?.startsWith('audio') ? (
                            <audio controls src={msg.mediaUrl} className="max-w-full" />
                          ) : msg.mediaType?.startsWith('video') ? (
                            <video controls src={msg.mediaUrl} className="max-w-full rounded" />
                          ) : (
                            <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="text-neon-blue underline">
                              Ver archivo
                            </a>
                          )}
                        </div>
                      )}
                      {msg.message && <p className="text-sm whitespace-pre-wrap">{msg.message}</p>}
                      <p className={`text-xs mt-1 ${msg.direction === 'outbound' ? 'text-blue-200' : 'text-gray-500'}`}>
                        {new Date(msg.createdAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-dark-card border-t border-dark-border">
                {previewFile && (
                  <div className="px-4 pt-3">
                    <div className="flex items-center gap-2 p-2 bg-dark-surface rounded-lg">
                      {previewFile.type === 'image' && (
                        <img src={previewFile.url} alt="" className="h-16 w-16 object-cover rounded" />
                      )}
                      {previewFile.type === 'video' && (
                        <video src={previewFile.url} className="h-16 w-16 object-cover rounded" />
                      )}
                      {previewFile.type === 'audio' && (
                        <div className="flex items-center gap-2 text-sm text-gray-400">
                          <span>🎤</span>
                          <span>Audio grabado</span>
                        </div>
                      )}
                      {previewFile.type === 'file' && (
                        <div className="flex items-center gap-2 text-sm text-gray-400">
                          <span>📄</span>
                          <span className="truncate max-w-[150px]">{previewFile.file.name}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={cancelPreview}
                        className="ml-auto p-1 text-gray-400 hover:text-white"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
                
                <form onSubmit={handleSendMessage} className="p-4 flex items-center gap-2">
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"
                  />
                  
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRecording || uploading}
                    className="p-2 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg transition-colors"
                    title="Adjuntar archivo"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>
                  
                  {isRecording ? (
                    <button
                      type="button"
                      onClick={handleStopRecording}
                      className="p-2 text-red-500 bg-red-500/20 rounded-lg animate-pulse"
                      title="Detener grabacion"
                    >
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStartRecording}
                      disabled={!!previewFile || uploading}
                      className="p-2 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg transition-colors disabled:opacity-50"
                      title="Grabar audio"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    </button>
                  )}
                  
                  <input
                    type="text"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    placeholder={isRecording ? 'Grabando...' : 'Escribe un mensaje...'}
                    disabled={isRecording}
                    className="input flex-1"
                  />
                  
                  <button
                    type="submit"
                    disabled={sending || uploading || isRecording || (!messageInput.trim() && !previewFile)}
                    className="btn btn-primary"
                  >
                    {uploading ? (
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : sending ? '...' : 'Enviar'}
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
