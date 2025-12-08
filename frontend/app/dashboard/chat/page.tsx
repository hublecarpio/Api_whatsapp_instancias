'use client';

import { useState, useEffect, useRef } from 'react';
import { useBusinessStore } from '@/store/business';
import { messageApi, waApi, mediaApi, businessApi, tagsApi, billingApi } from '@/lib/api';

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

interface Tag {
  id: string;
  name: string;
  color: string;
  description?: string;
  order: number;
  _count?: { assignments: number };
}

interface TagAssignment {
  tagId: string;
  contactPhone: string;
  tag: Tag;
}

interface WindowStatus {
  provider: string | null;
  requiresTemplate: boolean;
  windowOpen: boolean;
  hoursRemaining?: number;
  message: string;
}

interface DailyContactStats {
  count: number;
  limit: number;
  remaining: number;
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
  const [chatListOpen, setChatListOpen] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ file: File; url: string; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [botToggling, setBotToggling] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');
  const [tags, setTags] = useState<Tag[]>([]);
  const [assignments, setAssignments] = useState<TagAssignment[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [assigningTag, setAssigningTag] = useState(false);
  const [windowStatus, setWindowStatus] = useState<WindowStatus | null>(null);
  const [dailyContacts, setDailyContacts] = useState<DailyContactStats | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (currentBusiness) {
      fetchConversations();
      fetchTags();
      fetchDailyContacts();
      const interval = setInterval(() => {
        fetchConversations();
        fetchDailyContacts();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [currentBusiness]);

  const fetchDailyContacts = async () => {
    if (!currentBusiness) return;
    try {
      const response = await billingApi.getContactsToday(currentBusiness.id);
      setDailyContacts(response.data);
    } catch (err) {
      console.error('Failed to fetch daily contacts:', err);
    }
  };

  const fetchTags = async () => {
    if (!currentBusiness) return;
    try {
      const [tagsRes, assignmentsRes] = await Promise.all([
        tagsApi.list(currentBusiness.id),
        tagsApi.getAssignments(currentBusiness.id)
      ]);
      setTags(tagsRes.data);
      setAssignments(assignmentsRes.data);
      
      if (tagsRes.data.length === 0) {
        const initRes = await tagsApi.initDefaults(currentBusiness.id);
        setTags(initRes.data);
      }
    } catch (err) {
      console.error('Failed to fetch tags:', err);
    }
  };

  const handleAssignTag = async (phone: string, tagId: string) => {
    if (!currentBusiness) return;
    if (!tagId) {
      try {
        setAssigningTag(true);
        await tagsApi.unassign({ business_id: currentBusiness.id, contact_phone: phone });
        fetchTags();
      } catch (err) {
        console.error('Failed to unassign tag:', err);
      } finally {
        setAssigningTag(false);
      }
      return;
    }
    setAssigningTag(true);
    try {
      await tagsApi.assign({ business_id: currentBusiness.id, contact_phone: phone, tag_id: tagId });
      fetchTags();
    } catch (err) {
      console.error('Failed to assign tag:', err);
    } finally {
      setAssigningTag(false);
    }
  };

  const getContactTag = (phone: string): Tag | undefined => {
    const assignment = assignments.find(a => a.contactPhone === phone);
    return assignment?.tag;
  };

  const getConversationsByTag = (tagId: string | null): Conversation[] => {
    if (!tagId) {
      const assignedPhones = assignments.map(a => a.contactPhone);
      return conversations.filter(c => !assignedPhones.includes(c.phone));
    }
    const phonesForTag = assignments.filter(a => a.tagId === tagId).map(a => a.contactPhone);
    return conversations.filter(c => phonesForTag.includes(c.phone));
  };

  useEffect(() => {
    if (selectedPhone && currentBusiness) {
      fetchMessages(selectedPhone);
      fetchWindowStatus(selectedPhone);
      const interval = setInterval(() => {
        fetchMessages(selectedPhone);
        fetchWindowStatus(selectedPhone);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [selectedPhone, currentBusiness]);

  const fetchWindowStatus = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await messageApi.windowStatus(currentBusiness.id, phone);
      setWindowStatus(response.data);
    } catch (err) {
      console.error('Failed to fetch window status:', err);
    }
  };

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
        const { url, type, mimetype } = uploadRes.data;
        
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
          sendData.mimeType = mimetype || previewFile.file.type;
        }
        
        await waApi.send(currentBusiness.id, sendData);
        setPreviewFile(null);
        setUploading(false);
      } else {
        await waApi.send(currentBusiness.id, { to: selectedPhone, message: newMessage });
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
      console.error('Error accessing microphone:', error);
      setError('No se pudo acceder al microfono');
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return formatTime(dateStr);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Ayer';
    return date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
  };

  const isImageUrl = (url: string) => /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url);
  const isVideoUrl = (url: string) => /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(url);
  const isAudioUrl = (url: string) => /\.(ogg|mp3|wav|m4a|aac|opus|webm)(\?.*)?$/i.test(url);

  const renderMedia = (mediaUrl: string, isOutbound: boolean) => {
    if (isImageUrl(mediaUrl)) {
      return (
        <div className="mb-2">
          <img src={mediaUrl} alt="Media" className="max-w-full rounded-lg cursor-pointer hover:opacity-90" style={{ maxHeight: '200px' }} onClick={() => window.open(mediaUrl, '_blank')} />
        </div>
      );
    }
    if (isVideoUrl(mediaUrl)) {
      return <div className="mb-2"><video src={mediaUrl} controls className="max-w-full rounded-lg" style={{ maxHeight: '200px' }} /></div>;
    }
    if (isAudioUrl(mediaUrl)) {
      return (
        <div className={`mb-2 p-2 rounded-lg ${isOutbound ? 'bg-neon-blue-dark/30' : 'bg-dark-hover'}`}>
          <audio controls preload="metadata" className="h-10 w-full max-w-[180px]">
            <source src={mediaUrl} type="audio/ogg" />
            <source src={mediaUrl} type="audio/mpeg" />
          </audio>
        </div>
      );
    }
    return (
      <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 p-2 rounded-lg mb-2 ${isOutbound ? 'bg-neon-blue-dark/30' : 'bg-dark-hover'}`}>
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

  const showChatList = chatListOpen || !selectedPhone;

  return (
    <div className="h-[calc(100vh-120px)] sm:h-[calc(100vh-6rem)] flex flex-col bg-dark-bg">
      <div className="flex-1 flex overflow-hidden sm:rounded-2xl border border-dark-border bg-dark-surface shadow-dark-lg">
        <div className={`${showChatList ? 'w-full sm:w-80' : 'hidden sm:block sm:w-0'} transition-all duration-300 overflow-hidden border-r border-dark-border flex flex-col`}>
          <div className="p-3 border-b border-dark-border bg-dark-card">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-white">Chats</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 bg-dark-hover px-2 py-0.5 rounded-full">{conversations.length}</span>
                <button onClick={() => setViewMode(viewMode === 'list' ? 'kanban' : 'list')} className={`p-1.5 rounded-lg transition-colors ${viewMode === 'kanban' ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:bg-dark-hover'}`}>
                  {viewMode === 'list' ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /></svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                  )}
                </button>
              </div>
            </div>
            {dailyContacts && (
              <div className={`flex items-center justify-between text-xs px-2 py-1.5 rounded-lg mb-2 ${dailyContacts.remaining <= 10 ? 'bg-accent-error/20 text-accent-error' : dailyContacts.remaining <= 25 ? 'bg-accent-warning/20 text-accent-warning' : 'bg-accent-success/20 text-accent-success'}`}>
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                  Contactos hoy
                </span>
                <span className="font-medium">{dailyContacts.count}/{dailyContacts.limit}</span>
              </div>
            )}
            {viewMode === 'kanban' && tags.length > 0 && (
              <div className="flex gap-1 overflow-x-auto pb-1 hide-scrollbar">
                <button onClick={() => setSelectedTag(null)} className={`text-xs px-2 py-1 rounded-full whitespace-nowrap flex-shrink-0 ${selectedTag === null ? 'bg-white text-dark-bg' : 'bg-dark-hover text-gray-400 hover:bg-dark-border'}`}>Sin etiqueta</button>
                {tags.map(tag => (
                  <button key={tag.id} onClick={() => setSelectedTag(tag.id)} className="text-xs px-2 py-1 rounded-full whitespace-nowrap flex-shrink-0" style={{ backgroundColor: selectedTag === tag.id ? tag.color : `${tag.color}30`, color: selectedTag === tag.id ? 'white' : tag.color }}>{tag.name} ({getConversationsByTag(tag.id).length})</button>
                ))}
              </div>
            )}
          </div>
          
          <div className="flex-1 overflow-y-auto scrollbar-thin scroll-smooth-ios">
            {loading ? (
              <div className="p-4 text-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue mx-auto" /></div>
            ) : conversations.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">
                <div className="w-16 h-16 mx-auto mb-3 bg-dark-card rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                </div>
                No hay conversaciones
              </div>
            ) : (
              (viewMode === 'kanban' ? getConversationsByTag(selectedTag) : conversations).map((conv) => {
                const contactTag = getContactTag(conv.phone);
                return (
                  <button key={conv.phone} onClick={() => { setSelectedPhone(conv.phone); setSelectedContactName(conv.contactName || ''); setChatListOpen(false); }} className={`w-full p-3 text-left hover:bg-dark-hover transition-colors flex items-center gap-3 ${selectedPhone === conv.phone ? 'bg-neon-blue/10 border-l-2 border-neon-blue' : ''}`}>
                    <div className="w-12 h-12 bg-dark-card rounded-full flex items-center justify-center flex-shrink-0 relative">
                      <span className="text-xl">👤</span>
                      {contactTag && <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-dark-surface" style={{ backgroundColor: contactTag.color }} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-white truncate text-sm">{conv.contactName || `+${conv.phone}`}</p>
                        <span className="text-xs text-gray-500 flex-shrink-0 ml-2">{formatDate(conv.lastMessageAt)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-sm text-gray-400 truncate flex-1">{conv.lastMessage || 'Sin mensajes'}</p>
                        {contactTag && viewMode === 'list' && <span className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: `${contactTag.color}20`, color: contactTag.color }}>{contactTag.name}</span>}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className={`${selectedPhone ? 'flex' : 'hidden sm:flex'} flex-1 flex-col min-w-0`}>
          {selectedPhone ? (
            <>
              <div className="px-3 sm:px-4 py-3 border-b border-dark-border bg-dark-card flex items-center gap-3">
                <button onClick={() => { setChatListOpen(true); setSelectedPhone(null); }} className="sm:hidden p-1.5 text-gray-400 hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <button onClick={() => setChatListOpen(!chatListOpen)} className="hidden sm:block p-1 text-gray-500 hover:text-white transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {chatListOpen ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 5l7 7-7 7M5 5l7 7-7 7" />}
                  </svg>
                </button>
                <div className="w-10 h-10 bg-neon-blue/20 rounded-full flex items-center justify-center">
                  <span className="text-neon-blue text-lg">👤</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white truncate">{selectedContactName || `+${selectedPhone}`}</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button onClick={handleToggleBot} disabled={botToggling} className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors ${currentBusiness.botEnabled ? 'bg-accent-success/20 text-accent-success' : 'bg-dark-hover text-gray-400'}`}>
                      {currentBusiness.botEnabled ? '🤖 Bot' : '😴 Bot off'}
                    </button>
                    {windowStatus?.provider === 'META_CLOUD' && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${windowStatus.windowOpen ? 'bg-neon-blue/20 text-neon-blue' : 'bg-accent-warning/20 text-accent-warning'}`}>
                        {windowStatus.windowOpen ? `📬 ${windowStatus.hoursRemaining}h` : '📭 Template'}
                      </span>
                    )}
                  </div>
                </div>
                <select value={getContactTag(selectedPhone)?.id || ''} onChange={(e) => handleAssignTag(selectedPhone, e.target.value)} className="hidden sm:block text-xs bg-dark-card border border-dark-border rounded px-2 py-1 text-white" disabled={assigningTag}>
                  <option value="">Sin etapa</option>
                  {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                </select>
              </div>

              <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2 scroll-smooth-ios scrollbar-thin bg-dark-bg">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`chat-bubble ${msg.direction === 'outbound' ? 'chat-bubble-outgoing' : 'chat-bubble-incoming'}`}>
                      {msg.mediaUrl && renderMedia(msg.mediaUrl, msg.direction === 'outbound')}
                      {msg.message && <p className="break-words whitespace-pre-wrap text-sm sm:text-base">{msg.message}</p>}
                      <p className={`text-xs mt-1 text-right ${msg.direction === 'outbound' ? 'text-neon-blue-dark' : 'text-gray-500'}`}>
                        {formatTime(msg.createdAt)}
                        {msg.direction === 'outbound' && <span className="ml-1">✓✓</span>}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {previewFile && (
                <div className="px-3 py-2 border-t border-dark-border bg-dark-card">
                  <div className="flex items-center gap-3 p-2 bg-dark-surface rounded-lg border border-dark-border">
                    {previewFile.type === 'image' ? (
                      <img src={previewFile.url} alt="Preview" className="w-14 h-14 object-cover rounded" />
                    ) : previewFile.type === 'audio' ? (
                      <div className="flex items-center gap-2 flex-1">
                        <div className="w-10 h-10 bg-neon-blue/20 rounded-full flex items-center justify-center"><svg className="w-5 h-5 text-neon-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg></div>
                        <audio controls className="h-10 flex-1" style={{ maxWidth: '180px' }}><source src={previewFile.url} /></audio>
                      </div>
                    ) : (
                      <div className="w-14 h-14 bg-dark-hover rounded flex items-center justify-center"><svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg></div>
                    )}
                    <button onClick={cancelPreview} className="p-1.5 text-gray-400 hover:text-accent-error hover:bg-accent-error/10 rounded-full transition-colors"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                  </div>
                </div>
              )}

              {error && <div className="mx-3 mb-2 px-4 py-2 bg-accent-error/10 border border-accent-error/20 rounded-lg text-accent-error text-sm">{error}</div>}

              <form onSubmit={handleSend} className="p-3 border-t border-dark-border bg-dark-card safe-area-pb">
                <div className="flex items-center gap-2">
                  <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" accept="image/*,video/*,.pdf,.doc,.docx" />
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded-full transition-colors" disabled={sending}>
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  </button>
                  <button type="button" onClick={isRecording ? handleStopRecording : handleStartRecording} className={`p-2.5 rounded-full transition-colors ${isRecording ? 'bg-accent-error text-white animate-pulse' : 'text-gray-400 hover:text-white hover:bg-dark-hover'}`} disabled={sending && !isRecording}>
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                  </button>
                  <input type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} placeholder="Escribe un mensaje..." className="flex-1 px-4 py-2.5 bg-dark-surface border border-dark-border rounded-full text-white placeholder-gray-500 focus:outline-none focus:border-neon-blue focus:ring-1 focus:ring-neon-blue/50 text-sm sm:text-base" disabled={sending} />
                  <button type="submit" disabled={sending || (!newMessage.trim() && !previewFile)} className="p-2.5 bg-neon-blue text-dark-bg rounded-full hover:bg-neon-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-neon-sm">
                    {sending ? <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-dark-bg border-t-transparent rounded-full animate-spin" /> : <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 bg-dark-bg">
              <div className="w-24 h-24 bg-dark-card rounded-full flex items-center justify-center mb-4">
                <svg className="w-12 h-12 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
              </div>
              <p className="text-lg font-medium text-gray-400">Selecciona un chat</p>
              <p className="text-sm text-gray-500 mt-1">Elige una conversacion para comenzar</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
