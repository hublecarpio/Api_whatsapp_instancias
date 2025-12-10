'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useBusinessStore } from '@/store/business';
import { messageApi, waApi, mediaApi, businessApi, tagsApi, billingApi, templatesApi } from '@/lib/api';

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
  metadata?: {
    mediaAnalysis?: string;
    mediaType?: string;
    type?: string;
  };
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

interface Template {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  components: any[];
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
  const [contactBotDisabled, setContactBotDisabled] = useState<boolean>(false);
  const [contactBotToggling, setContactBotToggling] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState('');
  const [newChatMessage, setNewChatMessage] = useState('');
  const [newChatSending, setNewChatSending] = useState(false);
  const [instanceProvider, setInstanceProvider] = useState<string | null>(null);
  const [newChatTemplates, setNewChatTemplates] = useState<Template[]>([]);
  const [newChatUseTemplate, setNewChatUseTemplate] = useState(false);
  const [selectedNewChatTemplate, setSelectedNewChatTemplate] = useState<Template | null>(null);
  const [templateVariables, setTemplateVariables] = useState<string[]>([]);
  const [newChatTemplateVariables, setNewChatTemplateVariables] = useState<string[]>([]);
  const [contactData, setContactData] = useState<Record<string, any>>({});
  const [currentStage, setCurrentStage] = useState<{id: string; name: string; color: string} | null>(null);
  const [showContactPanel, setShowContactPanel] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const isNearBottomRef = useRef(true);
  const prevMessagesLengthRef = useRef(0);

  useEffect(() => {
    const handleViewportResize = () => {
      if (typeof window !== 'undefined' && window.visualViewport) {
        const viewport = window.visualViewport;
        const windowHeight = window.innerHeight;
        const viewportHeight = viewport.height;
        const newKeyboardHeight = windowHeight - viewportHeight;
        
        if (newKeyboardHeight > 100) {
          setKeyboardHeight(newKeyboardHeight);
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }, 100);
        } else {
          setKeyboardHeight(0);
        }
      }
    };

    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportResize);
      window.visualViewport.addEventListener('scroll', handleViewportResize);
    }

    return () => {
      if (typeof window !== 'undefined' && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportResize);
        window.visualViewport.removeEventListener('scroll', handleViewportResize);
      }
    };
  }, []);

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
      prevMessagesLengthRef.current = 0;
      isNearBottomRef.current = true;
      fetchMessages(selectedPhone);
      fetchWindowStatus(selectedPhone);
      fetchContactBotStatus(selectedPhone);
      fetchContactExtractedData(selectedPhone);
      const interval = setInterval(() => {
        fetchMessages(selectedPhone);
        fetchWindowStatus(selectedPhone);
        fetchContactExtractedData(selectedPhone);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [selectedPhone, currentBusiness]);

  const fetchContactBotStatus = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await tagsApi.getContactBotStatus(currentBusiness.id, phone);
      setContactBotDisabled(response.data.botDisabled || false);
    } catch (err) {
      console.error('Failed to fetch contact bot status:', err);
      setContactBotDisabled(false);
    }
  };

  const fetchContactExtractedData = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await tagsApi.getContactExtractedData(currentBusiness.id, phone);
      setContactData(response.data.extractedData || {});
      setCurrentStage(response.data.currentStage || null);
    } catch (err) {
      console.error('Failed to fetch contact extracted data:', err);
      setContactData({});
    }
  };

  const handleToggleContactBot = async () => {
    if (!currentBusiness || !selectedPhone) return;
    setContactBotToggling(true);
    try {
      const newStatus = !contactBotDisabled;
      await tagsApi.toggleContactBot(currentBusiness.id, selectedPhone, newStatus);
      setContactBotDisabled(newStatus);
    } catch (err) {
      console.error('Failed to toggle contact bot:', err);
    } finally {
      setContactBotToggling(false);
    }
  };

  const fetchWindowStatus = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await messageApi.windowStatus(currentBusiness.id, phone);
      setWindowStatus(response.data);
    } catch (err) {
      console.error('Failed to fetch window status:', err);
    }
  };

  const fetchTemplates = async () => {
    if (!currentBusiness) return;
    try {
      const response = await templatesApi.list(currentBusiness.id);
      const approvedTemplates = (response.data || []).filter((t: Template) => t.status === 'APPROVED');
      setTemplates(approvedTemplates);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
    }
  };

  const getTemplateVariableCount = (template: Template): number => {
    const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
    if (!bodyComponent?.text) return 0;
    const matches = bodyComponent.text.match(/\{\{\d+\}\}/g) || [];
    return matches.length;
  };

  const [selectedTemplateForSend, setSelectedTemplateForSend] = useState<Template | null>(null);

  const handleSelectTemplate = (template: Template) => {
    const varCount = getTemplateVariableCount(template);
    if (varCount > 0) {
      setSelectedTemplateForSend(template);
      setTemplateVariables(Array(varCount).fill(''));
    } else {
      handleSendTemplate(template, []);
    }
  };

  const handleSendTemplate = async (template: Template, variables: string[]) => {
    if (!currentBusiness || !selectedPhone) return;
    setSendingTemplate(true);
    try {
      await templatesApi.send(currentBusiness.id, {
        templateName: template.name,
        to: selectedPhone,
        variables: variables.length > 0 ? variables : undefined
      });
      setShowTemplateModal(false);
      setSelectedTemplateForSend(null);
      setTemplateVariables([]);
      fetchMessages(selectedPhone);
    } catch (err: any) {
      console.error('Failed to send template:', err);
      setError(err.response?.data?.error || 'Error al enviar plantilla');
      setTimeout(() => setError(null), 5000);
    } finally {
      setSendingTemplate(false);
    }
  };

  useEffect(() => {
    if (windowStatus?.provider === 'META_CLOUD' && !windowStatus?.windowOpen) {
      fetchTemplates();
    }
  }, [windowStatus, currentBusiness]);

  const fetchInstanceProvider = async () => {
    if (!currentBusiness) return;
    try {
      const response = await waApi.status(currentBusiness.id);
      if (response.data?.provider) {
        setInstanceProvider(response.data.provider);
      }
    } catch (err) {
      console.error('Failed to fetch instance provider:', err);
    }
  };

  const fetchNewChatTemplates = async () => {
    if (!currentBusiness) return;
    try {
      const response = await templatesApi.list(currentBusiness.id);
      const approvedTemplates = (response.data || []).filter((t: Template) => t.status === 'APPROVED');
      setNewChatTemplates(approvedTemplates);
    } catch (err) {
      console.error('Failed to fetch templates for new chat:', err);
    }
  };

  const openNewChatModal = () => {
    setNewChatPhone('');
    setNewChatMessage('');
    setNewChatUseTemplate(false);
    setSelectedNewChatTemplate(null);
    fetchInstanceProvider();
    if (instanceProvider === 'META_CLOUD') {
      fetchNewChatTemplates();
    }
    setShowNewChatModal(true);
  };

  useEffect(() => {
    if (showNewChatModal && instanceProvider === 'META_CLOUD') {
      fetchNewChatTemplates();
    }
  }, [showNewChatModal, instanceProvider]);

  const handleSendNewChat = async () => {
    if (!currentBusiness || !newChatPhone.trim()) return;
    
    const cleanPhone = newChatPhone.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      setError('Numero invalido');
      setTimeout(() => setError(null), 3000);
      return;
    }

    if (newChatUseTemplate && selectedNewChatTemplate) {
      const varCount = getTemplateVariableCount(selectedNewChatTemplate);
      if (varCount > 0 && newChatTemplateVariables.some(v => !v.trim())) {
        setError('Completa todas las variables de la plantilla');
        setTimeout(() => setError(null), 3000);
        return;
      }
    }

    setNewChatSending(true);
    setError(null);

    try {
      if (newChatUseTemplate && selectedNewChatTemplate) {
        await templatesApi.send(currentBusiness.id, {
          templateName: selectedNewChatTemplate.name,
          to: cleanPhone,
          variables: newChatTemplateVariables.length > 0 ? newChatTemplateVariables : undefined
        });
      } else if (newChatMessage.trim()) {
        await waApi.send(currentBusiness.id, { 
          to: cleanPhone, 
          message: newChatMessage 
        });
      } else {
        setError('Escribe un mensaje o selecciona una plantilla');
        setNewChatSending(false);
        return;
      }

      setShowNewChatModal(false);
      setNewChatTemplateVariables([]);
      fetchConversations();
      setSelectedPhone(cleanPhone);
      setSelectedContactName('');
      fetchMessages(cleanPhone);
      fetchWindowStatus(cleanPhone);
    } catch (err: any) {
      console.error('Failed to send new chat:', err);
      setError(err.response?.data?.error || 'Error al enviar mensaje');
      setTimeout(() => setError(null), 5000);
    } finally {
      setNewChatSending(false);
    }
  };

  const filteredConversations = conversations.filter(conv => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const phoneMatch = conv.phone.toLowerCase().includes(query);
    const nameMatch = conv.contactName?.toLowerCase().includes(query);
    return phoneMatch || nameMatch;
  });

  useEffect(() => {
    const isNewConversation = prevMessagesLengthRef.current === 0 && messages.length > 0;
    const hasNewMessages = messages.length > prevMessagesLengthRef.current;
    
    if (isNewConversation || (hasNewMessages && isNearBottomRef.current)) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    
    prevMessagesLengthRef.current = messages.length;
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

  const handleInputFocus = useCallback(() => {
    setIsInputFocused(true);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 300);
  }, []);

  const handleInputBlur = useCallback(() => {
    setIsInputFocused(false);
  }, []);

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

  const containerStyle = keyboardHeight > 0 
    ? { height: `calc(100vh - 120px - ${keyboardHeight}px)` } 
    : undefined;

  return (
    <div 
      ref={chatContainerRef}
      className="h-[calc(100dvh-120px)] sm:h-[calc(100vh-6rem)] flex flex-col bg-dark-bg transition-all duration-150"
      style={containerStyle}
    >
      <div className="flex-1 flex overflow-hidden sm:rounded-2xl border border-dark-border bg-dark-surface shadow-dark-lg">
        <div className={`${showChatList ? 'w-full sm:w-80' : 'hidden sm:block sm:w-0'} transition-all duration-300 overflow-hidden border-r border-dark-border flex flex-col`}>
          <div className="p-3 border-b border-dark-border bg-dark-card">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold text-white">Chats</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 bg-dark-hover px-2 py-0.5 rounded-full">{filteredConversations.length}</span>
                <button onClick={openNewChatModal} className="p-1.5 rounded-lg text-neon-blue hover:bg-neon-blue/20 transition-colors" title="Nuevo chat">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                </button>
                <button onClick={() => setViewMode(viewMode === 'list' ? 'kanban' : 'list')} className={`p-1.5 rounded-lg transition-colors ${viewMode === 'kanban' ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:bg-dark-hover'}`}>
                  {viewMode === 'list' ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /></svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                  )}
                </button>
              </div>
            </div>
            <div className="relative mb-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por numero o nombre..."
                className="w-full pl-8 pr-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-neon-blue"
              />
              <svg className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-white">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
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
            ) : filteredConversations.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">
                <div className="w-16 h-16 mx-auto mb-3 bg-dark-card rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                </div>
                {searchQuery ? 'No se encontraron resultados' : 'No hay conversaciones'}
              </div>
            ) : (
              (viewMode === 'kanban' ? getConversationsByTag(selectedTag) : filteredConversations).map((conv) => {
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
                    <button 
                      onClick={handleToggleContactBot} 
                      disabled={contactBotToggling} 
                      title={contactBotDisabled ? 'Bot desactivado para este contacto' : 'Bot activo para este contacto'}
                      className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                        contactBotDisabled 
                          ? 'bg-accent-error/20 text-accent-error' 
                          : currentBusiness.botEnabled 
                            ? 'bg-accent-success/20 text-accent-success' 
                            : 'bg-dark-hover text-gray-400'
                      }`}
                    >
                      {contactBotDisabled ? '🚫 Bot off' : currentBusiness.botEnabled ? '🤖 Bot' : '😴 Global off'}
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
                <button 
                  onClick={() => setShowContactPanel(!showContactPanel)}
                  className={`p-2 rounded-full transition-colors ${showContactPanel ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:text-white hover:bg-dark-hover'}`}
                  title="Datos del contacto"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              </div>

              {showContactPanel && (
                <div className="px-4 py-3 border-b border-dark-border bg-dark-surface">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium text-white">Datos del Contacto</h4>
                    {currentStage && (
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: `${currentStage.color}20`, color: currentStage.color }}>
                        {currentStage.name}
                      </span>
                    )}
                  </div>
                  {Object.keys(contactData).length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {contactData.nombre && (
                        <div><span className="text-gray-500">Nombre:</span> <span className="text-white">{contactData.nombre}</span></div>
                      )}
                      {contactData.email && (
                        <div><span className="text-gray-500">Email:</span> <span className="text-white">{contactData.email}</span></div>
                      )}
                      {contactData.direccion && (
                        <div className="col-span-2"><span className="text-gray-500">Dirección:</span> <span className="text-white">{contactData.direccion}</span></div>
                      )}
                      {contactData.ciudad && (
                        <div><span className="text-gray-500">Ciudad:</span> <span className="text-white">{contactData.ciudad}</span></div>
                      )}
                      {contactData.codigo_postal && (
                        <div><span className="text-gray-500">C.P.:</span> <span className="text-white">{contactData.codigo_postal}</span></div>
                      )}
                      {contactData.documento && (
                        <div><span className="text-gray-500">Documento:</span> <span className="text-white">{contactData.documento}</span></div>
                      )}
                      {contactData.notas && (
                        <div className="col-span-2"><span className="text-gray-500">Notas:</span> <span className="text-gray-400">{contactData.notas}</span></div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">Sin datos extraídos aún. Los datos se extraen automáticamente de las conversaciones.</p>
                  )}
                </div>
              )}

              <div 
                className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2 scroll-smooth-ios scrollbar-thin bg-dark-bg"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const threshold = 150;
                  isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
                }}
              >
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`chat-bubble ${msg.direction === 'outbound' ? 'chat-bubble-outgoing' : 'chat-bubble-incoming'}`}>
                      {msg.mediaUrl && renderMedia(msg.mediaUrl, msg.direction === 'outbound', msg.metadata?.mediaType || msg.metadata?.type)}
                      {msg.message && <p className="break-words whitespace-pre-wrap text-sm sm:text-base">{msg.message}</p>}
                      {msg.direction === 'inbound' && msg.metadata?.mediaAnalysis && (
                        <div className="mt-1 group relative inline-block">
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-purple-500/15 text-purple-400 rounded cursor-help">
                            <span>✨</span>
                            <span>Analizado</span>
                          </span>
                          <div className="absolute bottom-full left-0 mb-1 w-56 sm:w-64 p-2 bg-dark-card border border-purple-500/20 rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                            <p className="text-[10px] text-purple-400 font-medium mb-0.5">
                              {msg.metadata?.mediaType === 'audio' || msg.metadata?.type === 'audio' || msg.metadata?.type === 'ptt' ? '🎤 Transcripción:' : 
                               msg.metadata?.mediaType === 'image' || msg.metadata?.type === 'image' || msg.metadata?.type === 'sticker' ? '🖼️ Descripción:' : 
                               msg.metadata?.mediaType === 'video' || msg.metadata?.type === 'video' ? '🎬 Descripción:' : '📎 Análisis:'}
                            </p>
                            <p className="text-[10px] text-gray-400 whitespace-pre-wrap max-h-32 overflow-y-auto leading-relaxed">
                              {msg.metadata.mediaAnalysis}
                            </p>
                          </div>
                        </div>
                      )}
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
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="flex-shrink-0 p-2.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded-full transition-colors" disabled={sending || (windowStatus?.provider === 'META_CLOUD' && !windowStatus?.windowOpen)}>
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  </button>
                  <button type="button" onClick={isRecording ? handleStopRecording : handleStartRecording} className={`flex-shrink-0 p-2.5 rounded-full transition-colors ${isRecording ? 'bg-accent-error text-white animate-pulse' : 'text-gray-400 hover:text-white hover:bg-dark-hover'}`} disabled={(sending && !isRecording) || (windowStatus?.provider === 'META_CLOUD' && !windowStatus?.windowOpen)}>
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                  </button>
                  <input 
                    ref={inputRef}
                    type="text" 
                    value={newMessage} 
                    onChange={(e) => setNewMessage(e.target.value)} 
                    onFocus={handleInputFocus}
                    onBlur={handleInputBlur}
                    placeholder={windowStatus?.provider === 'META_CLOUD' && !windowStatus?.windowOpen ? "Ventana cerrada - usa plantilla" : "Escribe un mensaje..."} 
                    className="flex-1 min-w-0 px-4 py-2.5 bg-dark-surface border border-dark-border rounded-full text-white placeholder-gray-500 focus:outline-none focus:border-neon-blue focus:ring-1 focus:ring-neon-blue/50 text-sm sm:text-base" 
                    disabled={sending || (windowStatus?.provider === 'META_CLOUD' && !windowStatus?.windowOpen)}
                    enterKeyHint="send"
                    autoComplete="off"
                    autoCorrect="on"
                  />
                  {windowStatus?.provider === 'META_CLOUD' && !windowStatus?.windowOpen ? (
                    <button 
                      type="button" 
                      onClick={() => setShowTemplateModal(true)}
                      className="flex-shrink-0 p-2.5 bg-accent-warning text-dark-bg rounded-full hover:bg-accent-warning/80 transition-colors"
                      title="Enviar plantilla"
                    >
                      <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </button>
                  ) : (
                    <button type="submit" disabled={sending || (!newMessage.trim() && !previewFile)} className="flex-shrink-0 p-2.5 bg-neon-blue text-dark-bg rounded-full hover:bg-neon-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-neon-sm">
                      {sending ? <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-dark-bg border-t-transparent rounded-full animate-spin" /> : <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>}
                    </button>
                  )}
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

      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card border border-dark-border rounded-xl w-full max-w-md max-h-[80vh] overflow-hidden">
            <div className="p-4 border-b border-dark-border flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">
                {selectedTemplateForSend ? 'Completar Variables' : 'Seleccionar Plantilla'}
              </h3>
              <button onClick={() => { setShowTemplateModal(false); setSelectedTemplateForSend(null); setTemplateVariables([]); }} className="p-1 text-gray-400 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[60vh]">
              {selectedTemplateForSend ? (
                <div className="space-y-4">
                  <div className="p-3 bg-dark-surface border border-dark-border rounded-lg">
                    <p className="font-medium text-white mb-1">{selectedTemplateForSend.name}</p>
                    <p className="text-sm text-gray-400">
                      {selectedTemplateForSend.components?.find((c: any) => c.type === 'BODY')?.text || ''}
                    </p>
                  </div>
                  <div className="space-y-3">
                    <p className="text-sm text-gray-400">Completa los valores para las variables:</p>
                    {templateVariables.map((value, index) => (
                      <div key={index}>
                        <label className="block text-xs text-gray-500 mb-1">Variable {`{{${index + 1}}}`}</label>
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => {
                            const newVars = [...templateVariables];
                            newVars[index] = e.target.value;
                            setTemplateVariables(newVars);
                          }}
                          placeholder={`Valor para {{${index + 1}}}`}
                          className="w-full px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-neon-blue"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setSelectedTemplateForSend(null); setTemplateVariables([]); }}
                      className="flex-1 py-2 bg-dark-surface border border-dark-border rounded-lg text-gray-400 hover:text-white transition-colors"
                    >
                      Volver
                    </button>
                    <button
                      onClick={() => handleSendTemplate(selectedTemplateForSend, templateVariables)}
                      disabled={sendingTemplate || templateVariables.some(v => !v.trim())}
                      className="flex-1 py-2 bg-neon-blue text-dark-bg rounded-lg font-medium hover:bg-neon-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {sendingTemplate ? 'Enviando...' : 'Enviar'}
                    </button>
                  </div>
                </div>
              ) : templates.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-400">No hay plantillas aprobadas</p>
                  <p className="text-gray-500 text-sm mt-2">Ve a Plantillas para sincronizar desde Meta</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {templates.map((template) => {
                    const varCount = getTemplateVariableCount(template);
                    return (
                      <button
                        key={template.id}
                        onClick={() => handleSelectTemplate(template)}
                        disabled={sendingTemplate}
                        className="w-full p-3 bg-dark-surface border border-dark-border rounded-lg text-left hover:border-neon-blue transition-colors disabled:opacity-50"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-white">{template.name}</span>
                          <div className="flex items-center gap-2">
                            {varCount > 0 && (
                              <span className="text-xs px-2 py-0.5 bg-accent-warning/20 text-accent-warning rounded">{varCount} var{varCount > 1 ? 's' : ''}</span>
                            )}
                            <span className="text-xs px-2 py-0.5 bg-accent-success/20 text-accent-success rounded">{template.category}</span>
                          </div>
                        </div>
                        <p className="text-sm text-gray-400">
                          {template.components?.find((c: any) => c.type === 'BODY')?.text?.substring(0, 100) || 'Sin contenido de cuerpo'}
                          {(template.components?.find((c: any) => c.type === 'BODY')?.text?.length || 0) > 100 && '...'}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">Idioma: {template.language}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showNewChatModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-card border border-dark-border rounded-xl w-full max-w-md max-h-[80vh] overflow-hidden">
            <div className="p-4 border-b border-dark-border flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Nuevo Chat</h3>
              <button onClick={() => setShowNewChatModal(false)} className="p-1 text-gray-400 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Numero de telefono</label>
                <input
                  type="tel"
                  value={newChatPhone}
                  onChange={(e) => setNewChatPhone(e.target.value)}
                  placeholder="51999999999"
                  className="w-full px-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-neon-blue"
                />
                <p className="text-xs text-gray-500 mt-1">Incluye el codigo de pais sin + ni espacios</p>
              </div>

              {instanceProvider === 'META_CLOUD' && newChatTemplates.length > 0 && (
                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-400 mb-2">
                    <input
                      type="checkbox"
                      checked={newChatUseTemplate}
                      onChange={(e) => { 
                        setNewChatUseTemplate(e.target.checked); 
                        setSelectedNewChatTemplate(null); 
                        setNewChatTemplateVariables([]); 
                      }}
                      className="w-4 h-4 rounded bg-dark-surface border-dark-border text-neon-blue focus:ring-neon-blue"
                    />
                    Usar plantilla (Meta Cloud)
                  </label>
                  {newChatUseTemplate && (
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {newChatTemplates.map((template) => {
                        const varCount = getTemplateVariableCount(template);
                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => {
                              setSelectedNewChatTemplate(template);
                              setNewChatTemplateVariables(Array(varCount).fill(''));
                            }}
                            className={`w-full p-2 text-left rounded-lg border transition-colors ${
                              selectedNewChatTemplate?.id === template.id 
                                ? 'border-neon-blue bg-neon-blue/10' 
                                : 'border-dark-border bg-dark-surface hover:border-gray-600'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-white">{template.name}</span>
                              {varCount > 0 && (
                                <span className="text-xs px-1.5 py-0.5 bg-accent-warning/20 text-accent-warning rounded">{varCount} var</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 truncate">
                              {template.components?.find((c: any) => c.type === 'BODY')?.text?.substring(0, 50) || ''}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {selectedNewChatTemplate && newChatTemplateVariables.length > 0 && (
                    <div className="mt-3 space-y-2 p-3 bg-dark-surface rounded-lg border border-dark-border">
                      <p className="text-xs text-gray-400">Variables para {selectedNewChatTemplate.name}:</p>
                      {newChatTemplateVariables.map((value, index) => (
                        <input
                          key={index}
                          type="text"
                          value={value}
                          onChange={(e) => {
                            const newVars = [...newChatTemplateVariables];
                            newVars[index] = e.target.value;
                            setNewChatTemplateVariables(newVars);
                          }}
                          placeholder={`Valor para {{${index + 1}}}`}
                          className="w-full px-2 py-1.5 bg-dark-bg border border-dark-border rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-neon-blue"
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!newChatUseTemplate && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Mensaje</label>
                  <textarea
                    value={newChatMessage}
                    onChange={(e) => setNewChatMessage(e.target.value)}
                    placeholder="Escribe tu mensaje..."
                    rows={3}
                    className="w-full px-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-neon-blue resize-none"
                  />
                </div>
              )}

              {error && (
                <div className="px-3 py-2 bg-accent-error/10 border border-accent-error/20 rounded-lg text-accent-error text-sm">
                  {error}
                </div>
              )}

              <button
                onClick={handleSendNewChat}
                disabled={newChatSending || !newChatPhone.trim() || (!newChatMessage.trim() && !selectedNewChatTemplate) || !!(selectedNewChatTemplate && newChatTemplateVariables.length > 0 && newChatTemplateVariables.some(v => !v.trim()))}
                className="w-full py-2.5 bg-neon-blue text-dark-bg rounded-lg font-medium hover:bg-neon-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {newChatSending ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-dark-bg border-t-transparent rounded-full animate-spin" />
                    Enviando...
                  </div>
                ) : (
                  'Enviar mensaje'
                )}
              </button>

              {instanceProvider === 'META_CLOUD' && (
                <p className="text-xs text-gray-500 text-center">
                  Para numeros nuevos en Meta Cloud, usa una plantilla aprobada
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
