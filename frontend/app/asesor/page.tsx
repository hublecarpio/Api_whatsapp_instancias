'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { advisorApi, messageApi, mediaApi, waApi, tagsApi } from '@/lib/api';
import Logo from '@/components/Logo';

interface Business {
  id: string;
  name: string;
  description: string;
  businessObjective: string;
  assignedContactsCount: number;
}

interface Tag {
  id: string;
  name: string;
  color: string;
  order: number;
}

interface TagAssignment {
  phone: string;
  tagId: string;
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

interface Order {
  id: string;
  status: string;
  total: number;
  createdAt: string;
  items: { name: string; quantity: number; price: number }[];
  voucherImageUrl?: string;
}

interface Appointment {
  id: string;
  status: string;
  scheduledAt: string;
  service?: string;
  notes?: string;
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagAssignments, setTagAssignments] = useState<TagAssignment[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [assigningTag, setAssigningTag] = useState(false);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [contactOrders, setContactOrders] = useState<Order[]>([]);
  const [contactAppointments, setContactAppointments] = useState<Appointment[]>([]);
  const [loadingContactInfo, setLoadingContactInfo] = useState(false);
  const [contactBotDisabled, setContactBotDisabled] = useState(false);
  const [contactBotToggling, setContactBotToggling] = useState(false);
  const [contactRemindersPaused, setContactRemindersPaused] = useState(false);
  const [contactReminderToggling, setContactReminderToggling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
      loadTags();
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

  const loadTags = async () => {
    if (!selectedBusiness) return;
    try {
      const tagsRes = await tagsApi.list(selectedBusiness.id);
      setTags(tagsRes.data || []);
    } catch (error) {
      console.error('Error loading tags:', error);
      setTags([]);
    }
    try {
      const assignmentsRes = await tagsApi.getAssignments(selectedBusiness.id);
      const mappedAssignments = (assignmentsRes.data || []).map((a: any) => ({
        phone: a.contactPhone || a.phone,
        tagId: a.tagId
      }));
      setTagAssignments(mappedAssignments);
    } catch (error) {
      console.error('Error loading tag assignments:', error);
      setTagAssignments([]);
    }
  };

  useEffect(() => {
    if (selectedConversation && selectedBusiness) {
      loadMessages();
      loadContactInfo();
      loadContactSettings();
    } else {
      setContactOrders([]);
      setContactAppointments([]);
      setContactBotDisabled(false);
      setContactRemindersPaused(false);
    }
  }, [selectedConversation, selectedBusiness]);

  const loadContactSettings = async () => {
    if (!selectedConversation || !selectedBusiness) return;
    try {
      const [botRes, reminderRes] = await Promise.all([
        tagsApi.getContactBotStatus(selectedBusiness.id, selectedConversation.phone),
        tagsApi.getContactReminderStatus(selectedBusiness.id, selectedConversation.phone)
      ]);
      setContactBotDisabled(botRes.data.botDisabled || false);
      setContactRemindersPaused(reminderRes.data.remindersPaused || false);
    } catch (error) {
      console.error('Error loading contact settings:', error);
    }
  };

  const handleToggleContactBot = async () => {
    if (!selectedBusiness || !selectedConversation) return;
    setContactBotToggling(true);
    try {
      const newStatus = !contactBotDisabled;
      await tagsApi.toggleContactBot(selectedBusiness.id, selectedConversation.phone, newStatus);
      setContactBotDisabled(newStatus);
    } catch (err) {
      console.error('Failed to toggle contact bot:', err);
    } finally {
      setContactBotToggling(false);
    }
  };

  const handleToggleContactReminder = async () => {
    if (!selectedBusiness || !selectedConversation) return;
    setContactReminderToggling(true);
    try {
      const newStatus = !contactRemindersPaused;
      await tagsApi.toggleContactReminder(selectedBusiness.id, selectedConversation.phone, newStatus);
      setContactRemindersPaused(newStatus);
    } catch (err) {
      console.error('Failed to toggle contact reminder:', err);
    } finally {
      setContactReminderToggling(false);
    }
  };

  const loadContactInfo = async () => {
    if (!selectedConversation || !selectedBusiness) return;
    setLoadingContactInfo(true);
    try {
      const res = await advisorApi.getContactInfo(selectedBusiness.id, selectedConversation.phone);
      setContactOrders(res.data.orders || []);
      setContactAppointments(res.data.appointments || []);
    } catch (error) {
      console.error('Error loading contact info:', error);
      setContactOrders([]);
      setContactAppointments([]);
    } finally {
      setLoadingContactInfo(false);
    }
  };

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(event.target as Node)) {
        setShowTagDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleTagAssign = async (tagId: string | null) => {
    if (!selectedBusiness || !selectedConversation) return;
    setAssigningTag(true);
    const previousAssignments = [...tagAssignments];
    
    if (tagId === null) {
      setTagAssignments(prev => prev.filter(a => a.phone !== selectedConversation.phone));
    } else {
      setTagAssignments(prev => {
        const filtered = prev.filter(a => a.phone !== selectedConversation.phone);
        return [...filtered, { phone: selectedConversation.phone, tagId }];
      });
    }
    setShowTagDropdown(false);
    
    try {
      if (tagId === null) {
        await tagsApi.unassign({ 
          business_id: selectedBusiness.id, 
          contact_phone: selectedConversation.phone 
        });
      } else {
        await tagsApi.assign({ 
          business_id: selectedBusiness.id, 
          contact_phone: selectedConversation.phone, 
          tag_id: tagId,
          source: 'advisor_panel'
        });
      }
    } catch (error) {
      console.error('Error assigning tag:', error);
      setTagAssignments(previousAssignments);
    } finally {
      setAssigningTag(false);
    }
  };

  const selectConversation = (conv: Conversation) => {
    setSelectedConversation(conv);
    setSidebarOpen(false);
  };

  const getContactTag = useCallback((phone: string) => {
    const assignment = tagAssignments.find(a => a.phone === phone);
    if (!assignment) return null;
    return tags.find(t => t.id === assignment.tagId) || null;
  }, [tags, tagAssignments]);

  const getConversationsByTag = useCallback((tagId: string | null) => {
    const phones = tagId === null 
      ? conversations.filter(c => !tagAssignments.some(a => a.phone === c.phone)).map(c => c.phone)
      : tagAssignments.filter(a => a.tagId === tagId).map(a => a.phone);
    return conversations.filter(c => phones.includes(c.phone));
  }, [conversations, tagAssignments]);

  const filteredConversations = conversations.filter(conv => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return conv.phone.includes(query) || 
             (conv.contactName && conv.contactName.toLowerCase().includes(query));
    }
    return true;
  });

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

  const isImageUrl = (url: string) => /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url);
  const isVideoUrl = (url: string) => /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(url);
  const isAudioUrl = (url: string) => /\.(ogg|mp3|wav|m4a|aac|opus|webm)(\?.*)?$/i.test(url);

  const AudioPlayer = ({ src, isOutbound }: { src: string; isOutbound: boolean }) => {
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const audioRef = useRef<HTMLAudioElement>(null);
    const waveHeights = useRef([10, 14, 8, 16, 12, 10, 14, 8, 12, 16, 10, 14]);

    const togglePlay = () => {
      if (audioRef.current) {
        if (isPlaying) {
          audioRef.current.pause();
        } else {
          audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
      }
    };

    const formatDuration = (sec: number) => {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const progress = duration > 0 ? Math.floor((currentTime / duration) * 12) : 0;

    return (
      <div className="flex items-center gap-2 min-w-[160px]">
        <audio 
          ref={audioRef} 
          src={src} 
          preload="metadata"
          onLoadedMetadata={(e) => setDuration((e.target as HTMLAudioElement).duration)}
          onTimeUpdate={(e) => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
          onEnded={() => { setIsPlaying(false); setCurrentTime(0); }}
          className="hidden"
        />
        <button 
          onClick={togglePlay} 
          className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${isOutbound ? 'bg-white/20 hover:bg-white/30' : 'bg-neon-blue/20 hover:bg-neon-blue/30'}`}
        >
          {isPlaying ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
          ) : (
            <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <div className="flex-1 flex flex-col gap-1">
          <div className="flex items-end gap-[3px] h-4">
            {waveHeights.current.map((h, i) => (
              <div 
                key={i} 
                className={`w-[3px] rounded-sm transition-colors duration-150 ${
                  i < progress 
                    ? (isOutbound ? 'bg-white' : 'bg-neon-blue') 
                    : (isOutbound ? 'bg-white/30' : 'bg-gray-600')
                }`}
                style={{ height: `${h}px` }}
              />
            ))}
          </div>
          <span className={`text-[10px] ${isOutbound ? 'text-white/60' : 'text-gray-400'}`}>
            {formatDuration(currentTime > 0 ? currentTime : duration || 0)}
          </span>
        </div>
      </div>
    );
  };

  const renderMedia = (mediaUrl: string, isOutbound: boolean, mediaType?: string) => {
    const type = mediaType?.toLowerCase() || '';
    const isAudio = type === 'audio' || type === 'ptt' || isAudioUrl(mediaUrl);
    const isImage = type === 'image' || type === 'sticker' || isImageUrl(mediaUrl);
    const isVideo = type === 'video' || isVideoUrl(mediaUrl);
    
    if (isImage) {
      return (
        <img 
          src={mediaUrl} 
          alt="" 
          className="max-w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity" 
          style={{ maxHeight: '200px', maxWidth: '220px' }} 
          onClick={() => window.open(mediaUrl, '_blank')} 
        />
      );
    }
    if (isVideo) {
      return (
        <div className="relative rounded-lg overflow-hidden" style={{ maxWidth: '220px' }}>
          <video 
            src={mediaUrl} 
            controls 
            className="max-w-full" 
            style={{ maxHeight: '180px' }} 
          />
        </div>
      );
    }
    if (isAudio) {
      return <AudioPlayer src={mediaUrl} isOutbound={isOutbound} />;
    }
    const fileName = mediaUrl.split('/').pop()?.split('?')[0] || 'archivo';
    return (
      <a 
        href={mediaUrl} 
        target="_blank" 
        rel="noopener noreferrer" 
        className={`inline-flex items-center gap-1.5 text-sm ${isOutbound ? 'text-white/90 hover:text-white' : 'text-neon-blue hover:text-neon-blue-light'}`}
      >
        <span>📄</span>
        <span className="underline underline-offset-2">{fileName.length > 20 ? fileName.slice(0, 17) + '...' : fileName}</span>
      </a>
    );
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-dark-bg">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-neon-blue border-t-transparent"></div>
      </div>
    );
  }

  if (businesses.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-dark-bg p-4">
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

  const showChatList = sidebarOpen || !selectedConversation;

  return (
    <div className="h-screen bg-dark-bg flex flex-col overflow-hidden">
      <header className="flex-shrink-0 bg-dark-card border-b border-dark-border px-3 md:px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-4">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="md:hidden p-2 -ml-1 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <Logo size="sm" />
          <div className="hidden md:block h-6 w-px bg-dark-border"></div>
          <span className="hidden md:block text-sm text-gray-400">Panel de Asesor</span>
          {businesses.length > 1 && (
            <select
              value={selectedBusiness?.id || ''}
              onChange={(e) => {
                const biz = businesses.find(b => b.id === e.target.value);
                setSelectedBusiness(biz || null);
                setSelectedConversation(null);
                setMessages([]);
              }}
              className="input py-1 text-sm max-w-[120px] md:max-w-none"
            >
              {businesses.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <span className="hidden sm:block text-sm text-gray-400 truncate max-w-[100px]">{user?.name}</span>
          <button onClick={handleLogout} className="btn btn-secondary btn-sm text-xs md:text-sm">
            Salir
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {sidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        
        <div className={`
          fixed md:relative inset-y-0 left-0 z-50 md:z-auto
          w-[85%] max-w-[320px] md:w-80 md:max-w-none
          bg-dark-card border-r border-dark-border flex flex-col h-full
          transform transition-transform duration-300 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          md:transform-none
        `} style={{ top: 0 }}>
          <div className="flex-shrink-0 p-3 border-b border-dark-border bg-dark-card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium text-white">Chats</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 bg-dark-hover px-2 py-0.5 rounded-full">{filteredConversations.length}</span>
                <button 
                  onClick={() => setViewMode(viewMode === 'list' ? 'kanban' : 'list')} 
                  className={`p-1.5 rounded-lg transition-colors ${viewMode === 'kanban' ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:bg-dark-hover'}`}
                  title={viewMode === 'list' ? 'Ver etapas' : 'Ver lista'}
                >
                  {viewMode === 'list' ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /></svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                  )}
                </button>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="md:hidden p-1.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar..."
                className="w-full pl-8 pr-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-neon-blue"
              />
              <svg className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            {viewMode === 'kanban' && tags.length > 0 && (
              <div className="flex gap-1 overflow-x-auto pb-1 mt-2 hide-scrollbar">
                <button 
                  onClick={() => setSelectedTag(null)} 
                  className={`text-xs px-2 py-1 rounded-full whitespace-nowrap flex-shrink-0 ${selectedTag === null ? 'bg-white text-dark-bg' : 'bg-dark-hover text-gray-400 hover:bg-dark-border'}`}
                >
                  Sin etiqueta ({getConversationsByTag(null).length})
                </button>
                {tags.map(tag => (
                  <button 
                    key={tag.id} 
                    onClick={() => setSelectedTag(tag.id)} 
                    className="text-xs px-2 py-1 rounded-full whitespace-nowrap flex-shrink-0" 
                    style={{ backgroundColor: selectedTag === tag.id ? tag.color : `${tag.color}30`, color: selectedTag === tag.id ? 'white' : tag.color }}
                  >
                    {tag.name} ({getConversationsByTag(tag.id).length})
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">
                No tienes conversaciones asignadas
              </div>
            ) : viewMode === 'kanban' ? (
              (selectedTag !== null ? getConversationsByTag(selectedTag) : getConversationsByTag(null)).map(conv => {
                const tag = getContactTag(conv.phone);
                return (
                  <button
                    key={conv.phone}
                    onClick={() => selectConversation(conv)}
                    className={`w-full text-left p-3 border-b border-dark-border hover:bg-dark-bg/50 transition-colors ${
                      selectedConversation?.phone === conv.phone ? 'bg-dark-bg/50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-white truncate text-sm">
                            {conv.contactName || conv.phone}
                          </p>
                          {tag && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: `${tag.color}30`, color: tag.color }}>
                              {tag.name}
                            </span>
                          )}
                        </div>
                        {conv.lastMessage && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            {conv.lastMessage}
                          </p>
                        )}
                      </div>
                      {conv.unread > 0 && (
                        <span className="bg-neon-blue text-white text-xs rounded-full px-2 py-0.5 flex-shrink-0">
                          {conv.unread}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            ) : (
              filteredConversations.map(conv => {
                const tag = getContactTag(conv.phone);
                return (
                  <button
                    key={conv.phone}
                    onClick={() => selectConversation(conv)}
                    className={`w-full text-left p-3 border-b border-dark-border hover:bg-dark-bg/50 transition-colors ${
                      selectedConversation?.phone === conv.phone ? 'bg-dark-bg/50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-white truncate text-sm">
                            {conv.contactName || conv.phone}
                          </p>
                          {tag && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: `${tag.color}30`, color: tag.color }}>
                              {tag.name}
                            </span>
                          )}
                        </div>
                        {conv.contactName && (
                          <p className="text-[11px] text-gray-500">{conv.phone}</p>
                        )}
                        {conv.lastMessage && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            {conv.lastMessage}
                          </p>
                        )}
                      </div>
                      {conv.unread > 0 && (
                        <span className="bg-neon-blue text-white text-xs rounded-full px-2 py-0.5 flex-shrink-0">
                          {conv.unread}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
          {!selectedConversation ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-4">
              <svg className="w-16 h-16 mb-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className="text-center">Selecciona una conversacion</p>
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden mt-4 btn btn-primary btn-sm"
              >
                Ver conversaciones
              </button>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 bg-dark-card border-b border-dark-border px-3 md:px-4 py-3 flex items-center gap-3">
                <button
                  onClick={() => {
                    setSelectedConversation(null);
                    setSidebarOpen(true);
                  }}
                  className="md:hidden p-2 -ml-1 text-gray-400 hover:text-white hover:bg-dark-hover rounded-lg"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white truncate">
                    {selectedConversation.contactName || selectedConversation.phone}
                  </p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {selectedConversation.contactName && (
                      <span className="text-xs text-gray-500 truncate">{selectedConversation.phone}</span>
                    )}
                    <button 
                      onClick={handleToggleContactBot} 
                      disabled={contactBotToggling} 
                      title={contactBotDisabled ? 'Bot desactivado' : 'Bot activo'}
                      className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                        contactBotDisabled 
                          ? 'bg-red-500/20 text-red-400' 
                          : 'bg-green-500/20 text-green-400'
                      }`}
                    >
                      {contactBotDisabled ? '🚫 Bot off' : '🤖 Bot'}
                    </button>
                    <button 
                      onClick={handleToggleContactReminder} 
                      disabled={contactReminderToggling} 
                      title={contactRemindersPaused ? 'Recordatorios pausados' : 'Recordatorios activos'}
                      className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                        contactRemindersPaused 
                          ? 'bg-yellow-500/20 text-yellow-400' 
                          : 'bg-purple-500/20 text-purple-400'
                      }`}
                    >
                      {contactRemindersPaused ? '⏸️ Rec off' : '🔔 Rec'}
                    </button>
                  </div>
                </div>
                <div className="relative" ref={tagDropdownRef}>
                  <button
                    onClick={() => setShowTagDropdown(!showTagDropdown)}
                    disabled={assigningTag}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors ${
                      getContactTag(selectedConversation.phone) 
                        ? 'hover:opacity-80' 
                        : 'bg-dark-hover text-gray-400 hover:bg-dark-border hover:text-white'
                    } ${assigningTag ? 'opacity-50' : ''}`}
                    style={getContactTag(selectedConversation.phone) ? {
                      backgroundColor: `${getContactTag(selectedConversation.phone)!.color}30`,
                      color: getContactTag(selectedConversation.phone)!.color
                    } : undefined}
                  >
                    {assigningTag ? (
                      <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                      </svg>
                    )}
                    <span>{getContactTag(selectedConversation.phone)?.name || 'Etiqueta'}</span>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showTagDropdown && (
                    <div className="absolute right-0 top-full mt-1 w-48 bg-dark-card border border-dark-border rounded-lg shadow-xl z-50 py-1 max-h-64 overflow-y-auto">
                      <button
                        onClick={() => handleTagAssign(null)}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-dark-hover transition-colors flex items-center gap-2 ${
                          !getContactTag(selectedConversation.phone) ? 'text-white bg-dark-hover' : 'text-gray-400'
                        }`}
                      >
                        <span className="w-3 h-3 rounded-full bg-gray-600"></span>
                        Sin etiqueta
                      </button>
                      {tags.map(tag => (
                        <button
                          key={tag.id}
                          onClick={() => handleTagAssign(tag.id)}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-dark-hover transition-colors flex items-center gap-2 ${
                            getContactTag(selectedConversation.phone)?.id === tag.id ? 'bg-dark-hover' : ''
                          }`}
                        >
                          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }}></span>
                          <span className="truncate" style={{ color: tag.color }}>{tag.name}</span>
                          {getContactTag(selectedConversation.phone)?.id === tag.id && (
                            <svg className="w-4 h-4 ml-auto text-neon-blue flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setShowInfoPanel(!showInfoPanel)}
                  className={`p-2 rounded-lg transition-colors ${showInfoPanel ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:bg-dark-hover hover:text-white'}`}
                  title="Ver info del contacto"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>

              {showInfoPanel && (
                <div className="md:hidden bg-dark-card border-b border-dark-border max-h-48 overflow-y-auto">
                  <div className="p-3 space-y-3">
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        Citas ({contactAppointments.length})
                      </h4>
                      {contactAppointments.length === 0 ? (
                        <p className="text-xs text-gray-500">Sin citas</p>
                      ) : (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {contactAppointments.slice(0, 3).map(apt => (
                            <div key={apt.id} className="flex-shrink-0 text-xs bg-dark-surface rounded px-2 py-1">
                              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${apt.status === 'CONFIRMED' ? 'bg-green-500' : apt.status === 'PENDING' ? 'bg-yellow-500' : 'bg-gray-500'}`}></span>
                              {new Date(apt.scheduledAt).toLocaleDateString('es', { day: 'numeric', month: 'short' })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" /></svg>
                        Pedidos ({contactOrders.length})
                      </h4>
                      {contactOrders.length === 0 ? (
                        <p className="text-xs text-gray-500">Sin pedidos</p>
                      ) : (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {contactOrders.slice(0, 3).map(order => (
                            <div key={order.id} className="flex-shrink-0 text-xs bg-dark-surface rounded px-2 py-1">
                              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${order.status === 'PAID' ? 'bg-green-500' : order.status === 'PENDING' ? 'bg-yellow-500' : 'bg-gray-500'}`}></span>
                              ${order.total?.toFixed(2) || '0.00'}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-3 bg-dark-bg">
                    {messages.map(msg => (
                      <div
                        key={msg.id}
                        className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[85%] md:max-w-[70%] rounded-xl px-3 py-2 ${
                            msg.direction === 'outbound'
                              ? 'bg-neon-blue text-white rounded-br-sm'
                              : 'bg-dark-card text-white rounded-bl-sm'
                          } ${msg.metadata?.pending ? 'opacity-70' : ''}`}
                        >
                          {msg.mediaUrl && (
                            <div className="mb-2">
                              {renderMedia(msg.mediaUrl, msg.direction === 'outbound', msg.mediaType || msg.metadata?.mediaType || msg.metadata?.type)}
                            </div>
                          )}
                          {msg.message && <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>}
                          <p className={`text-[10px] mt-1 ${msg.direction === 'outbound' ? 'text-blue-200' : 'text-gray-500'}`}>
                            {new Date(msg.createdAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>

                  <div className="flex-shrink-0 bg-dark-card border-t border-dark-border">
                    {previewFile && (
                      <div className="px-3 md:px-4 pt-3">
                        <div className="flex items-center gap-2 p-2 bg-dark-surface rounded-lg">
                          {previewFile.type === 'image' && (
                            <img src={previewFile.url} alt="" className="h-14 w-14 object-cover rounded" />
                          )}
                          {previewFile.type === 'video' && (
                            <video src={previewFile.url} className="h-14 w-14 object-cover rounded" />
                          )}
                          {previewFile.type === 'audio' && (
                            <div className="flex items-center gap-2 text-sm text-gray-400">
                              <span className="text-lg">🎤</span>
                              <span>Audio grabado</span>
                            </div>
                          )}
                          {previewFile.type === 'file' && (
                            <div className="flex items-center gap-2 text-sm text-gray-400">
                              <span className="text-lg">📄</span>
                              <span className="truncate max-w-[120px]">{previewFile.file.name}</span>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={cancelPreview}
                            className="ml-auto p-2 text-gray-400 hover:text-white rounded-lg"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}
                    
                    <form onSubmit={handleSendMessage} className="p-3 md:p-4 flex items-center gap-1 md:gap-2">
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
                        className="p-2.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded-xl transition-colors touch-manipulation"
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
                          className="p-2.5 text-red-500 bg-red-500/20 rounded-xl animate-pulse touch-manipulation"
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
                          className="p-2.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded-xl transition-colors disabled:opacity-50 touch-manipulation"
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
                        placeholder={isRecording ? 'Grabando...' : 'Mensaje...'}
                        disabled={isRecording}
                        className="flex-1 min-w-0 px-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-neon-blue"
                      />
                      
                      <button
                        type="submit"
                        disabled={sending || isRecording || (!messageInput.trim() && !previewFile)}
                        className="p-2.5 bg-neon-blue text-white rounded-xl hover:bg-neon-blue/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
                      >
                        {uploading ? (
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                          </svg>
                        )}
                      </button>
                    </form>
                  </div>
                </div>

                {showInfoPanel && (
                  <div className="hidden md:flex w-72 flex-shrink-0 border-l border-dark-border bg-dark-card flex-col overflow-hidden">
                    <div className="p-4 border-b border-dark-border">
                      <h3 className="font-medium text-white text-sm">Info del contacto</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {loadingContactInfo ? (
                        <div className="flex justify-center py-8">
                          <div className="w-6 h-6 border-2 border-neon-blue border-t-transparent rounded-full animate-spin"></div>
                        </div>
                      ) : (
                        <>
                          <div>
                            <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                              Citas ({contactAppointments.length})
                            </h4>
                            {contactAppointments.length === 0 ? (
                              <p className="text-xs text-gray-500 italic">Sin citas agendadas</p>
                            ) : (
                              <div className="space-y-2">
                                {contactAppointments.map(apt => (
                                  <div key={apt.id} className="bg-dark-surface rounded-lg p-2.5">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                        apt.status === 'CONFIRMED' ? 'bg-green-500/20 text-green-400' :
                                        apt.status === 'PENDING' ? 'bg-yellow-500/20 text-yellow-400' :
                                        apt.status === 'COMPLETED' ? 'bg-blue-500/20 text-blue-400' :
                                        'bg-gray-500/20 text-gray-400'
                                      }`}>
                                        {apt.status === 'CONFIRMED' ? 'Confirmada' :
                                         apt.status === 'PENDING' ? 'Pendiente' :
                                         apt.status === 'COMPLETED' ? 'Completada' : apt.status}
                                      </span>
                                    </div>
                                    <p className="text-sm text-white">
                                      {new Date(apt.scheduledAt).toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                      {new Date(apt.scheduledAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                                    </p>
                                    {apt.service && <p className="text-xs text-gray-500 mt-1">{apt.service}</p>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div>
                            <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" /></svg>
                              Pedidos ({contactOrders.length})
                            </h4>
                            {contactOrders.length === 0 ? (
                              <p className="text-xs text-gray-500 italic">Sin pedidos</p>
                            ) : (
                              <div className="space-y-2">
                                {contactOrders.map(order => (
                                  <div key={order.id} className="bg-dark-surface rounded-lg p-2.5">
                                    <div className="flex items-center justify-between mb-1">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                        order.status === 'PAID' ? 'bg-green-500/20 text-green-400' :
                                        order.status === 'PENDING' ? 'bg-yellow-500/20 text-yellow-400' :
                                        order.status === 'DELIVERED' ? 'bg-blue-500/20 text-blue-400' :
                                        order.status === 'AWAITING_VOUCHER' ? 'bg-orange-500/20 text-orange-400' :
                                        'bg-gray-500/20 text-gray-400'
                                      }`}>
                                        {order.status === 'PAID' ? 'Pagado' :
                                         order.status === 'PENDING' ? 'Pendiente' :
                                         order.status === 'DELIVERED' ? 'Entregado' :
                                         order.status === 'AWAITING_VOUCHER' ? 'Esperando voucher' : order.status}
                                      </span>
                                      <span className="text-sm font-medium text-white">${order.total?.toFixed(2) || '0.00'}</span>
                                    </div>
                                    <p className="text-xs text-gray-400">
                                      {new Date(order.createdAt).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}
                                    </p>
                                    {order.items && order.items.length > 0 && (
                                      <div className="mt-1.5 space-y-0.5">
                                        {order.items.slice(0, 2).map((item, idx) => (
                                          <p key={idx} className="text-xs text-gray-500 truncate">
                                            {item.quantity}x {item.name}
                                          </p>
                                        ))}
                                        {order.items.length > 2 && (
                                          <p className="text-xs text-gray-600">+{order.items.length - 2} mas</p>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
