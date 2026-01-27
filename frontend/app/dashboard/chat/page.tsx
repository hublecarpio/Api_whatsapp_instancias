'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useBusinessStore } from '@/store/business';
import { useInstanceStore } from '@/store/instance';
import { useAuthStore } from '@/store/auth';
import { messageApi, waApi, mediaApi, businessApi, tagsApi, billingApi, templatesApi, advisorApi, extractionApi, funnelStagesApi } from '@/lib/api';

interface Conversation {
  phone: string;
  contactName: string;
  lastMessage: string | null;
  lastMessageAt: string;
  lastMessageDirection: 'inbound' | 'outbound';
  messageCount: number;
  instanceId?: string | null;
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
    pending?: boolean;
    mediaPending?: boolean;
    isTemplate?: boolean;
    templateName?: string;
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

interface Advisor {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  _count: { contactAssignments: number };
}

interface AdvisorInvitation {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

interface ContactAssignment {
  businessId: string;
  contactPhone: string;
  userId: string;
  user: { id: string; name: string; email: string };
}

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentBusiness } = useBusinessStore();
  const { selectedInstanceId, setSelectedInstanceId, instances, setInstances } = useInstanceStore();
  const { activeContext } = useAuthStore();
  const isAdvisorMode = activeContext?.role === 'ADVISOR';
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [selectedConversationInstanceId, setSelectedConversationInstanceId] = useState<string | null>(null);
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
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [windowStatus, setWindowStatus] = useState<WindowStatus | null>(null);
  const [dailyContacts, setDailyContacts] = useState<DailyContactStats | null>(null);
  const [contactBotDisabled, setContactBotDisabled] = useState<boolean>(false);
  const [contactBotToggling, setContactBotToggling] = useState(false);
  const [contactBotTestEnabled, setContactBotTestEnabled] = useState<boolean>(false);
  const [contactBotTestToggling, setContactBotTestToggling] = useState(false);
  const [contactRemindersPaused, setContactRemindersPaused] = useState<boolean>(false);
  const [contactReminderToggling, setContactReminderToggling] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [responseFilter, setResponseFilter] = useState<'all' | 'responded' | 'waiting'>('all');
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
  const [extractedFields, setExtractedFields] = useState<Array<{
    fieldKey: string;
    fieldLabel: string;
    fieldType: string;
    value: string | null;
    confidence: number | null;
    source: string | null;
  }>>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [savingField, setSavingField] = useState(false);
  const [currentStage, setCurrentStage] = useState<{id: string; name: string; color: string} | null>(null);
  const [contactTags, setContactTags] = useState<Record<string, Tag[]>>({});
  const [funnelStage, setFunnelStage] = useState<{id: string; name: string; order: number} | null>(null);
  const [availableFunnelStages, setAvailableFunnelStages] = useState<Array<{id: string; name: string; order: number}>>([]);
  const [changingFunnelStage, setChangingFunnelStage] = useState(false);
  const [showContactPanel, setShowContactPanel] = useState(false);
  const [showTeamPanel, setShowTeamPanel] = useState(false);
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [deleteIncludeOrders, setDeleteIncludeOrders] = useState(false);
  const [deleteIncludeAppointments, setDeleteIncludeAppointments] = useState(false);
  const [invitations, setInvitations] = useState<AdvisorInvitation[]>([]);
  const [contactAssignments, setContactAssignments] = useState<ContactAssignment[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [roundRobinEnabled, setRoundRobinEnabled] = useState(false);
  const [roundRobinAdvisors, setRoundRobinAdvisors] = useState<string[]>([]);
  const [roundRobinWeights, setRoundRobinWeights] = useState<Record<string, number>>({});
  const [savingRoundRobin, setSavingRoundRobin] = useState(false);
  const [contextMenu, setContextMenu] = useState<{x: number; y: number; phone: string; contactName: string} | null>(null);
  const [showCreateTagModal, setShowCreateTagModal] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [tagDropdownPhone, setTagDropdownPhone] = useState<string | null>(null);
  const [tagDropdownPosition, setTagDropdownPosition] = useState<{x: number; y: number} | null>(null);
  const [tagQuickAddRef, setTagQuickAddRef] = useState<{phone: string; element: HTMLElement} | null>(null);
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

  const handleSelectConversation = useCallback((phone: string, contactName: string, instanceId: string | null) => {
    setSelectedPhone(phone);
    setSelectedContactName(contactName || '');
    setSelectedConversationInstanceId(instanceId);
    setChatListOpen(false);
    
    // Cargar etiquetas del contacto seleccionado
    fetchContactTags(phone);
    
    const selectedInst = instances.find(i => i.id === instanceId);
    if (selectedInst?.instanceNumber) {
      router.replace(`/dashboard/chat?instance=${selectedInst.instanceNumber}&phone=${encodeURIComponent(phone)}`, { scroll: false });
    } else {
      router.replace(`/dashboard/chat?phone=${encodeURIComponent(phone)}`, { scroll: false });
    }
  }, [instances, router]);

  useEffect(() => {
    const phoneParam = searchParams.get('phone');
    const instanceParam = searchParams.get('instance');
    
    if (instances.length > 0 && instanceParam) {
      const instNumber = parseInt(instanceParam, 10);
      const targetInstance = instances.find(i => i.instanceNumber === instNumber);
      if (targetInstance && targetInstance.id !== selectedInstanceId) {
        setSelectedInstanceId(targetInstance.id);
      }
    }
    
    if (phoneParam && conversations.length > 0 && !selectedPhone) {
      let conv;
      if (instanceParam && instances.length > 0) {
        const instNumber = parseInt(instanceParam, 10);
        const targetInstance = instances.find(i => i.instanceNumber === instNumber);
        if (targetInstance) {
          conv = conversations.find(c => c.phone === phoneParam && c.instanceId === targetInstance.id);
        }
      }
      if (!conv) {
        conv = conversations.find(c => c.phone === phoneParam);
      }
      if (conv) {
        setSelectedPhone(conv.phone);
        setSelectedContactName(conv.contactName || '');
        setSelectedConversationInstanceId(conv.instanceId || null);
        setChatListOpen(false);
      }
    }
  }, [searchParams, conversations, selectedPhone, instances, selectedInstanceId, setSelectedInstanceId]);

  useEffect(() => {
    const handleViewportResize = () => {
      if (typeof window !== 'undefined' && window.visualViewport) {
        const viewport = window.visualViewport;
        const windowHeight = window.innerHeight;
        const viewportHeight = viewport.height;
        const newKeyboardHeight = windowHeight - viewportHeight;
        
        if (newKeyboardHeight > 100) {
          setKeyboardHeight(newKeyboardHeight);
          // No auto-scroll - el usuario controla el scroll manualmente
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
      fetchFunnelStages();
      fetchDailyContacts();
      const interval = setInterval(() => {
        fetchConversations();
        fetchDailyContacts();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [currentBusiness]);

  // Cargar etiquetas de todos los contactos cuando se cargan las conversaciones
  useEffect(() => {
    if (conversations.length > 0 && currentBusiness) {
      conversations.forEach(conv => {
        fetchContactTags(conv.phone);
      });
    }
  }, [conversations, currentBusiness]);

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

  const fetchFunnelStages = async () => {
    if (!currentBusiness) return;
    try {
      const res = await funnelStagesApi.list(currentBusiness.id, selectedInstanceId || undefined);
      setAvailableFunnelStages(res.data || []);
    } catch (err) {
      console.error('Failed to fetch funnel stages:', err);
    }
  };

  const handleChangeFunnelStage = async (stageId: string) => {
    if (!currentBusiness || !selectedPhone) return;
    setChangingFunnelStage(true);
    try {
      await funnelStagesApi.setContactStage(
        currentBusiness.id, 
        selectedPhone, 
        stageId || null, 
        selectedConversationInstanceId || undefined
      );
      await fetchContactExtractedData(selectedPhone);
    } catch (err) {
      console.error('Failed to change funnel stage:', err);
    } finally {
      setChangingFunnelStage(false);
    }
  };

  const fetchTeamData = async () => {
    if (!currentBusiness) return;
    setLoadingTeam(true);
    try {
      const [teamRes, invitationsRes, assignmentsRes, roundRobinRes] = await Promise.all([
        advisorApi.getTeam(currentBusiness.id),
        advisorApi.getInvitations(currentBusiness.id),
        advisorApi.getAssignments(currentBusiness.id),
        advisorApi.getRoundRobin(currentBusiness.id)
      ]);
      setAdvisors(teamRes.data);
      setInvitations(invitationsRes.data.filter((i: AdvisorInvitation) => !i.acceptedAt));
      setContactAssignments(assignmentsRes.data);
      setRoundRobinEnabled(roundRobinRes.data.roundRobinEnabled);
      setRoundRobinAdvisors(roundRobinRes.data.roundRobinAdvisors || []);
      setRoundRobinWeights(roundRobinRes.data.roundRobinWeights || {});
    } catch (err) {
      console.error('Failed to fetch team data:', err);
    } finally {
      setLoadingTeam(false);
    }
  };

  const handleToggleRoundRobin = async () => {
    if (!currentBusiness) return;
    setSavingRoundRobin(true);
    try {
      const newEnabled = !roundRobinEnabled;
      await advisorApi.updateRoundRobin(currentBusiness.id, { enabled: newEnabled });
      setRoundRobinEnabled(newEnabled);
    } catch (err) {
      console.error('Failed to toggle round-robin:', err);
    } finally {
      setSavingRoundRobin(false);
    }
  };

  const handleToggleRoundRobinAdvisor = async (advisorId: string) => {
    if (!currentBusiness) return;
    setSavingRoundRobin(true);
    try {
      const newAdvisors = roundRobinAdvisors.includes(advisorId)
        ? roundRobinAdvisors.filter(id => id !== advisorId)
        : [...roundRobinAdvisors, advisorId];
      
      // Keep existing weights for advisors that remain, add default weight for new ones
      const newWeights = { ...roundRobinWeights };
      if (!roundRobinAdvisors.includes(advisorId)) {
        newWeights[advisorId] = 1; // Default weight for new advisor
      }
      
      await advisorApi.updateRoundRobin(currentBusiness.id, { advisorIds: newAdvisors, weights: newWeights });
      setRoundRobinAdvisors(newAdvisors);
      setRoundRobinWeights(newWeights);
    } catch (err) {
      console.error('Failed to update round-robin advisors:', err);
    } finally {
      setSavingRoundRobin(false);
    }
  };

  const handleUpdateAdvisorWeight = async (advisorId: string, weight: number) => {
    if (!currentBusiness) return;
    const clampedWeight = Math.max(1, Math.min(10, Math.floor(weight)));
    
    // Update local state immediately for responsiveness
    const newWeights = { ...roundRobinWeights, [advisorId]: clampedWeight };
    setRoundRobinWeights(newWeights);
    
    // Debounce API call
    setSavingRoundRobin(true);
    try {
      await advisorApi.updateRoundRobin(currentBusiness.id, { weights: newWeights });
    } catch (err) {
      console.error('Failed to update advisor weight:', err);
    } finally {
      setSavingRoundRobin(false);
    }
  };

  const handleInviteAdvisor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBusiness || !inviteEmail.trim()) return;
    setInviting(true);
    try {
      await advisorApi.invite({ email: inviteEmail.trim(), businessId: currentBusiness.id });
      setInviteEmail('');
      fetchTeamData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al enviar invitacion');
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvitation = async (id: string) => {
    try {
      await advisorApi.cancelInvitation(id);
      fetchTeamData();
    } catch (err) {
      console.error('Failed to cancel invitation:', err);
    }
  };

  const handleRemoveAdvisor = async (advisorId: string) => {
    if (!currentBusiness) return;
    if (!confirm('Seguro que deseas eliminar este asesor?')) return;
    try {
      await advisorApi.removeAdvisor(advisorId, currentBusiness.id);
      fetchTeamData();
    } catch (err) {
      console.error('Failed to remove advisor:', err);
    }
  };

  const handleAssignContact = async (phone: string, advisorId: string) => {
    if (!currentBusiness) return;
    try {
      if (advisorId) {
        await advisorApi.assignContact({ businessId: currentBusiness.id, contactPhone: phone, advisorId });
      } else {
        await advisorApi.removeAssignment(currentBusiness.id, phone);
      }
      fetchTeamData();
    } catch (err) {
      console.error('Failed to assign contact:', err);
    }
  };

  const getContactAdvisor = (phone: string): { id: string; name: string } | null => {
    const assignment = contactAssignments.find(a => a.contactPhone === phone);
    return assignment ? { id: assignment.userId, name: assignment.user.name } : null;
  };

  const handleAssignTag = async (phone: string, tagId: string) => {
    if (!currentBusiness) return;
    if (!tagId) {
      // If tagId is empty, do nothing (we don't remove all tags anymore)
      return;
    }
    setAssigningTag(true);
    try {
      await tagsApi.assign({ business_id: currentBusiness.id, contact_phone: phone, tag_id: tagId });
      // Refresh tags for this contact
      await fetchContactTags(phone);
      if (phone === selectedPhone) {
        fetchContactExtractedData(phone);
      }
    } catch (err) {
      console.error('Failed to assign tag:', err);
    } finally {
      setAssigningTag(false);
    }
  };

  const handleRemoveTag = async (phone: string, tagId: string) => {
    if (!currentBusiness) return;
    setAssigningTag(true);
    try {
      await tagsApi.removeAssignment(currentBusiness.id, phone, tagId);
      // Refresh tags for this contact
      await fetchContactTags(phone);
      if (phone === selectedPhone) {
        fetchContactExtractedData(phone);
      }
    } catch (err) {
      console.error('Failed to remove tag:', err);
    } finally {
      setAssigningTag(false);
    }
  };

  const fetchContactTags = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await tagsApi.getContactTags(currentBusiness.id, phone);
      const contactTagsData = Array.isArray(response.data) ? response.data : (response.data ? [response.data] : []);
      const tagsList = contactTagsData.map((assignment: any) => assignment.tag || assignment).filter(Boolean);
      setContactTags(prev => ({ ...prev, [phone]: tagsList }));
    } catch (err) {
      console.error('Failed to fetch contact tags:', err);
      setContactTags(prev => ({ ...prev, [phone]: [] }));
    }
  };

  const getContactTag = (phone: string): Tag | undefined => {
    // For backward compatibility, return first tag
    const tags = contactTags[phone] || [];
    return tags[0];
  };

  const getContactTags = (phone: string): Tag[] => {
    return contactTags[phone] || [];
  };

  const getConversationsByTag = (tagId: string | null): Conversation[] => {
    if (!tagId) {
      // Show conversations without any tags
      return conversations.filter(c => {
        const tags = getContactTags(c.phone);
        return tags.length === 0;
      });
    }
    // Show conversations that have this specific tag
    return conversations.filter(c => {
      const tags = getContactTags(c.phone);
      return tags.some(t => t.id === tagId);
    });
  };

  const handleContextMenu = (e: React.MouseEvent, phone: string, contactName: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, phone, contactName });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  useEffect(() => {
    if (selectedPhone && currentBusiness) {
      prevMessagesLengthRef.current = 0;
      isNearBottomRef.current = true;
      fetchMessages(selectedPhone, selectedConversationInstanceId);
      fetchWindowStatus(selectedPhone, selectedConversationInstanceId);
      fetchContactBotStatus(selectedPhone);
      fetchContactReminderStatus(selectedPhone);
      fetchContactExtractedData(selectedPhone);
      const interval = setInterval(() => {
        fetchMessages(selectedPhone, selectedConversationInstanceId);
        fetchWindowStatus(selectedPhone, selectedConversationInstanceId);
        fetchContactExtractedData(selectedPhone);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [selectedPhone, currentBusiness, selectedConversationInstanceId]);

  const fetchContactBotStatus = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await tagsApi.getContactBotStatus(currentBusiness.id, phone);
      setContactBotDisabled(response.data.botDisabled || false);
      setContactBotTestEnabled(response.data.botTestEnabled || false);
    } catch (err) {
      console.error('Failed to fetch contact bot status:', err);
      setContactBotDisabled(false);
      setContactBotTestEnabled(false);
    }
  };

  const fetchContactReminderStatus = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const response = await tagsApi.getContactReminderStatus(currentBusiness.id, phone);
      setContactRemindersPaused(response.data.remindersPaused || false);
    } catch (err) {
      console.error('Failed to fetch contact reminder status:', err);
      setContactRemindersPaused(false);
    }
  };

  const fetchContactExtractedData = async (phone: string) => {
    if (!currentBusiness) return;
    try {
      const [extractionRes, stageRes] = await Promise.all([
        extractionApi.getContactData(currentBusiness.id, phone),
        tagsApi.getContactExtractedData(currentBusiness.id, phone),
        fetchContactTags(phone)
      ]);
      setExtractedFields(extractionRes.data || []);
      const dataMap: Record<string, any> = {};
      (extractionRes.data || []).forEach((f: any) => {
        if (f.value) dataMap[f.fieldKey] = f.value;
      });
      setContactData(dataMap);
      // For backward compatibility, set first tag as currentStage
      const contactTagsList = contactTags[phone] || [];
      setCurrentStage(contactTagsList[0] ? { id: contactTagsList[0].id, name: contactTagsList[0].name, color: contactTagsList[0].color } : null);
      setFunnelStage(stageRes.data.funnelStage || null);
    } catch (err) {
      console.error('Failed to fetch contact extracted data:', err);
      setContactData({});
      setExtractedFields([]);
      setFunnelStage(null);
    }
  };

  const handleSaveExtractedField = async (fieldKey: string, value: string) => {
    if (!currentBusiness || !selectedPhone) return;
    setSavingField(true);
    try {
      await extractionApi.updateContactData(currentBusiness.id, selectedPhone, { [fieldKey]: value });
      await fetchContactExtractedData(selectedPhone);
      setEditingField(null);
      setEditingValue('');
    } catch (err) {
      console.error('Failed to save extracted field:', err);
    } finally {
      setSavingField(false);
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

  const handleToggleBotTestMode = async () => {
    if (!currentBusiness || !selectedPhone) return;
    setContactBotTestToggling(true);
    try {
      const newStatus = !contactBotTestEnabled;
      await tagsApi.toggleContactBotTest(currentBusiness.id, selectedPhone, newStatus);
      setContactBotTestEnabled(newStatus);
    } catch (err) {
      console.error('Failed to toggle bot test mode:', err);
    } finally {
      setContactBotTestToggling(false);
    }
  };

  const handleToggleContactReminder = async () => {
    if (!currentBusiness || !selectedPhone) return;
    setContactReminderToggling(true);
    try {
      const newStatus = !contactRemindersPaused;
      await tagsApi.toggleContactReminder(currentBusiness.id, selectedPhone, newStatus);
      setContactRemindersPaused(newStatus);
    } catch (err) {
      console.error('Failed to toggle contact reminder:', err);
    } finally {
      setContactReminderToggling(false);
    }
  };

  const handleDeleteConversation = async () => {
    if (!currentBusiness || !selectedPhone) return;
    setDeletingConversation(true);
    try {
      await messageApi.deleteConversation(
        currentBusiness.id, 
        selectedPhone, 
        undefined,
        { includeOrders: deleteIncludeOrders, includeAppointments: deleteIncludeAppointments }
      );
      setShowDeleteConfirm(false);
      setDeleteIncludeOrders(false);
      setDeleteIncludeAppointments(false);
      setMessages([]);
      setSelectedPhone(null);
      fetchConversations();
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    } finally {
      setDeletingConversation(false);
    }
  };

  const fetchWindowStatus = async (phone: string, instanceId?: string | null) => {
    if (!currentBusiness) return;
    try {
      const effectiveInstanceId = instanceId || selectedConversationInstanceId || selectedInstanceId;
      const response = await messageApi.windowStatus(currentBusiness.id, phone, effectiveInstanceId || undefined);
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
      const effectiveInstanceId = selectedConversationInstanceId || selectedInstanceId || undefined;
      await templatesApi.send(currentBusiness.id, {
        templateName: template.name,
        to: selectedPhone,
        variables: variables.length > 0 ? variables : undefined,
        instanceId: effectiveInstanceId
      });
      setShowTemplateModal(false);
      setSelectedTemplateForSend(null);
      setTemplateVariables([]);
      fetchMessages(selectedPhone, selectedConversationInstanceId);
    } catch (err: any) {
      console.error('Failed to send template:', err);
      setError(err.response?.data?.error || 'Error al enviar plantilla');
      setTimeout(() => setError(null), 5000);
    } finally {
      setSendingTemplate(false);
    }
  };

  useEffect(() => {
    if (['META_CLOUD', 'META_COEXIST'].includes(windowStatus?.provider || '') && !windowStatus?.windowOpen) {
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
    if (['META_CLOUD', 'META_COEXIST'].includes(instanceProvider || '')) {
      fetchNewChatTemplates();
    }
    setShowNewChatModal(true);
  };

  useEffect(() => {
    if (showNewChatModal && ['META_CLOUD', 'META_COEXIST'].includes(instanceProvider || '')) {
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
          variables: newChatTemplateVariables.length > 0 ? newChatTemplateVariables : undefined,
          instanceId: selectedInstanceId || undefined
        });
      } else if (newChatMessage.trim()) {
        await waApi.send(currentBusiness.id, { 
          to: cleanPhone, 
          message: newChatMessage,
          instanceId: selectedInstanceId || undefined
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
      setSelectedConversationInstanceId(selectedInstanceId);
      fetchMessages(cleanPhone, selectedInstanceId);
      fetchWindowStatus(cleanPhone, selectedInstanceId);
    } catch (err: any) {
      console.error('Failed to send new chat:', err);
      const errorMsg = err.response?.data?.error || 'Error al enviar mensaje';
      const errorDetails = err.response?.data?.details;
      setError(errorDetails ? `${errorMsg}: ${errorDetails}` : errorMsg);
      setTimeout(() => setError(null), 8000);
    } finally {
      setNewChatSending(false);
    }
  };

  const filteredConversations = conversations.filter(conv => {
    // Response filter (with fallback for undefined lastMessageDirection)
    const direction = conv.lastMessageDirection || 'outbound';
    if (responseFilter === 'responded' && direction !== 'inbound') return false;
    if (responseFilter === 'waiting' && direction !== 'outbound') return false;
    
    // Search filter
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const phoneMatch = conv.phone.toLowerCase().includes(query);
    const nameMatch = conv.contactName?.toLowerCase().includes(query);
    return phoneMatch || nameMatch;
  });

  useEffect(() => {
    const isNewConversation = prevMessagesLengthRef.current === 0 && messages.length > 0;
    
    // SOLO scroll automático cuando se abre una conversación nueva
    // Después de eso, todo el scroll es manual por el usuario
    if (isNewConversation) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    
    prevMessagesLengthRef.current = messages.length;
  }, [messages]);

  const fetchConversations = async (instanceIdOverride?: string | null) => {
    if (!currentBusiness) return;
    try {
      const effectiveInstanceId = instanceIdOverride !== undefined ? instanceIdOverride : selectedInstanceId;
      const response = await messageApi.conversations(currentBusiness.id, effectiveInstanceId || undefined);
      setConversations(response.data);
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchMessages = async (phone: string, instanceId?: string | null) => {
    if (!currentBusiness) return;
    try {
      const response = await messageApi.conversation(currentBusiness.id, phone, instanceId || undefined);
      setMessages(response.data);
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  };
  
  useEffect(() => {
    if (currentBusiness) {
      waApi.listInstances(currentBusiness.id).then(res => {
        const loadedInstances = res.data.instances || [];
        setInstances(loadedInstances);
        // Auto-select first instance if multiple and none selected
        if (loadedInstances.length > 1 && !selectedInstanceId) {
          setSelectedInstanceId(loadedInstances[0].id);
        }
      }).catch(err => {
        console.error('Failed to fetch instances:', err);
      });
    }
  }, [currentBusiness, setInstances, selectedInstanceId, setSelectedInstanceId]);
  
  const [instanceSwitching, setInstanceSwitching] = useState(false);
  const prevInstanceIdRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (currentBusiness && selectedInstanceId !== prevInstanceIdRef.current) {
      prevInstanceIdRef.current = selectedInstanceId;
      if (!instanceSwitching) {
        setSelectedPhone(null);
        setSelectedConversationInstanceId(null);
        setMessages([]);
        setConversations([]);
        fetchConversations(selectedInstanceId);
      }
    }
  }, [selectedInstanceId, currentBusiness]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBusiness || !selectedPhone || (!newMessage.trim() && !previewFile)) return;

    const tempId = `temp-${Date.now()}`;
    const messageCopy = newMessage;
    const fileCopy = previewFile;

    const optimisticMessage: Message = {
      id: tempId,
      direction: 'outbound',
      message: previewFile ? undefined : messageCopy,
      mediaUrl: previewFile?.url,
      createdAt: new Date().toISOString(),
      metadata: { 
        pending: true,
        mediaType: previewFile?.type
      }
    };

    setMessages(prev => [...prev, optimisticMessage]);
    setNewMessage('');
    setSending(true);
    setError(null);

    try {
      if (fileCopy) {
        setUploading(true);
        const uploadRes = await mediaApi.upload(currentBusiness.id, fileCopy.file);
        const { url, type, mimetype } = uploadRes.data;
        
        const effectiveInstanceId = selectedConversationInstanceId || selectedInstanceId || undefined;
        const sendData: any = { to: selectedPhone, instanceId: effectiveInstanceId };
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
        
        await waApi.send(currentBusiness.id, sendData);
        setPreviewFile(null);
        setUploading(false);
      } else {
        const effectiveInstanceId = selectedConversationInstanceId || selectedInstanceId || undefined;
        await waApi.send(currentBusiness.id, { to: selectedPhone, message: messageCopy, instanceId: effectiveInstanceId });
      }
      
      fetchMessages(selectedPhone, selectedConversationInstanceId);
    } catch (err: any) {
      console.error('Failed to send message:', err);
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setNewMessage(messageCopy);
      if (fileCopy) setPreviewFile(fileCopy);
      const errorMsg = err.response?.data?.error || 'Error al enviar mensaje';
      const errorDetails = err.response?.data?.details;
      setError(errorDetails ? `${errorMsg}: ${errorDetails}` : errorMsg);
      setTimeout(() => setError(null), 8000);
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
    // No auto-scroll - el usuario controla el scroll manualmente
  }, []);

  const handleInputBlur = useCallback(() => {
    setIsInputFocused(false);
  }, []);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const time = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    
    if (date.toDateString() === today.toDateString()) {
      return time;
    }
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `Ayer ${time}`;
    }
    
    const dateFormatted = date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
    return `${dateFormatted} ${time}`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const time = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    if (date.toDateString() === today.toDateString()) return time;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Ayer ${time}`;
    return date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' }) + ` ${time}`;
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
        <div className={`${showChatList ? 'w-full sm:w-64 lg:w-72' : 'hidden sm:block sm:w-0'} transition-all duration-300 overflow-hidden border-r border-dark-border flex flex-col`}>
          <div className="p-3 border-b border-dark-border bg-dark-card">
            {instances.length > 1 && (
              <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                {instanceSwitching && (
                  <div className="animate-spin w-3 h-3 border border-neon-blue border-t-transparent rounded-full mr-1"></div>
                )}
                {instances.map((inst: any) => {
                  const isConnected = inst.status === 'open' || inst.status === 'connected';
                  const isSelected = selectedInstanceId === inst.id;
                  return (
                    <button
                      key={inst.id}
                      onClick={async () => {
                        if (isSelected) return;
                        setInstanceSwitching(true);
                        setSelectedInstanceId(inst.id);
                        setSelectedPhone(null);
                        setSelectedConversationInstanceId(null);
                        setMessages([]);
                        setConversations([]);
                        router.replace(`/dashboard/chat?instance=${inst.instanceNumber}`, { scroll: false });
                        await fetchConversations(inst.id);
                        setInstanceSwitching(false);
                      }}
                      disabled={instanceSwitching}
                      className={`px-2 py-1 rounded text-xs transition-all flex items-center gap-1 ${
                        isSelected
                          ? 'bg-neon-blue/20 text-neon-blue'
                          : 'text-gray-500 hover:text-gray-300'
                      } ${instanceSwitching ? 'opacity-50 cursor-wait' : ''}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></span>
                      {inst.name || inst.phoneNumber || `#${inst.id.slice(-4)}`}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-white">Chats</h2>
                {selectedInstanceId && instances.length > 1 && (
                  <span className="px-2 py-0.5 bg-neon-blue/20 text-neon-blue text-xs rounded-full">
                    {instances.find((i: any) => i.id === selectedInstanceId)?.name || 
                     instances.find((i: any) => i.id === selectedInstanceId)?.phoneNumber || 
                     'Instancia'}
                  </span>
                )}
              </div>
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
                {!isAdvisorMode && (
                  <button 
                    onClick={() => { setShowTeamPanel(true); fetchTeamData(); }} 
                    className="p-1.5 rounded-lg text-gray-400 hover:bg-dark-hover transition-colors" 
                    title="Equipo de asesores"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                  </button>
                )}
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
            <div className="flex gap-1 mb-2">
              <button 
                onClick={() => setResponseFilter('all')} 
                className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${responseFilter === 'all' ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:bg-dark-hover'}`}
              >
                Todos
              </button>
              <button 
                onClick={() => setResponseFilter('responded')} 
                className={`flex-1 text-xs py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1 ${responseFilter === 'responded' ? 'bg-accent-success/20 text-accent-success' : 'text-gray-400 hover:bg-dark-hover'}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                Respondieron
              </button>
              <button 
                onClick={() => setResponseFilter('waiting')} 
                className={`flex-1 text-xs py-1.5 rounded-lg transition-colors flex items-center justify-center gap-1 ${responseFilter === 'waiting' ? 'bg-accent-warning/20 text-accent-warning' : 'text-gray-400 hover:bg-dark-hover'}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                Esperando
              </button>
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
            {/* Lista de etiquetas - Compacta y colapsable */}
            {tags.length > 0 && (
              <div className="mb-1.5">
                <button
                  onClick={() => setTagsExpanded(!tagsExpanded)}
                  className="w-full flex items-center justify-between px-1.5 py-1 rounded hover:bg-dark-hover transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <svg 
                      className={`w-3 h-3 text-gray-400 transition-transform ${tagsExpanded ? 'rotate-90' : ''}`} 
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-[11px] font-medium text-gray-400">Etiquetas</span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-dark-surface text-gray-500">{tags.length}</span>
                  </div>
                  {selectedTag && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neon-blue/20 text-neon-blue">
                      Filtro activo
                    </span>
                  )}
                </button>
                {tagsExpanded && (
                  <div className="mt-1 space-y-0.5 max-h-[120px] overflow-y-auto scrollbar-thin scrollbar-track-dark-bg scrollbar-thumb-dark-border">
                    <button 
                      onClick={() => setSelectedTag(null)} 
                      className={`w-full text-left text-[11px] px-1.5 py-1 rounded flex items-center justify-between transition-all duration-150 ${
                        selectedTag === null 
                          ? 'bg-neon-blue/20 text-neon-blue border border-neon-blue/50' 
                          : 'bg-dark-hover text-gray-400 hover:bg-dark-border hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-gray-600 border border-dark-border" />
                        <span className="font-medium truncate">Todos</span>
                      </div>
                      <span className="text-[10px] px-1 py-0.5 rounded-full bg-dark-surface opacity-70 flex-shrink-0">
                        {getConversationsByTag(null).length}
                      </span>
                    </button>
                    {tags.map(tag => {
                      const count = getConversationsByTag(tag.id).length;
                      return (
                        <button 
                          key={tag.id} 
                          onClick={() => setSelectedTag(tag.id)} 
                          className={`w-full text-left text-[11px] px-1.5 py-1 rounded flex items-center justify-between transition-all duration-150 ${
                            selectedTag === tag.id 
                              ? 'border' 
                              : 'hover:bg-dark-border'
                          }`}
                          style={{ 
                            backgroundColor: selectedTag === tag.id ? `${tag.color}30` : 'transparent',
                            color: selectedTag === tag.id ? tag.color : 'inherit',
                            borderColor: selectedTag === tag.id ? `${tag.color}50` : 'transparent'
                          }}
                        >
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <div 
                              className="w-2 h-2 rounded-full flex-shrink-0 border border-dark-border" 
                              style={{ backgroundColor: tag.color }}
                            />
                            <span className="font-medium truncate">{tag.name}</span>
                          </div>
                          <span className="text-[10px] px-1 py-0.5 rounded-full bg-dark-surface opacity-70 flex-shrink-0 ml-1">
                            {count}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setShowCreateTagModal(true)}
                      className="w-full text-left text-[10px] px-1.5 py-1 rounded text-gray-500 hover:text-white hover:bg-dark-hover transition-colors flex items-center gap-1"
                    >
                      <span>+</span> Crear etiqueta
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          
          <div className="flex-1 overflow-y-auto scrollbar-thin scroll-smooth-ios">
            {(loading || instanceSwitching) ? (
              <div className="p-4 text-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue mx-auto mb-2" />
                {instanceSwitching && <p className="text-xs text-gray-400">Cambiando bandeja...</p>}
              </div>
            ) : filteredConversations.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">
                <div className="w-16 h-16 mx-auto mb-3 bg-dark-card rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                </div>
                {searchQuery ? 'No se encontraron resultados' : 'No hay conversaciones'}
              </div>
            ) : (
              filteredConversations.map((conv) => {
                const contactTagsList = getContactTags(conv.phone);
                return (
                  <button 
                    key={conv.phone} 
                    onClick={() => handleSelectConversation(conv.phone, conv.contactName || '', conv.instanceId || null)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      handleContextMenu(e, conv.phone, conv.contactName || '');
                    }}
                    className={`w-full p-3 text-left hover:bg-dark-hover transition-colors flex items-center gap-3 ${selectedPhone === conv.phone ? 'bg-neon-blue/10 border-l-2 border-neon-blue' : ''}`}
                  >
                    <div className="w-12 h-12 bg-dark-card rounded-full flex items-center justify-center flex-shrink-0 relative">
                      <span className="text-xl">👤</span>
                      {contactTagsList.length > 0 && (
                        <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-dark-surface" style={{ backgroundColor: contactTagsList[0].color }} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-white truncate text-sm">{conv.contactName || `+${conv.phone}`}</p>
                        <span className="text-xs text-gray-500 flex-shrink-0 ml-2">{formatDate(conv.lastMessageAt)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`flex-shrink-0 ${(conv.lastMessageDirection || 'outbound') === 'inbound' ? 'text-accent-success' : 'text-gray-500'}`} title={conv.lastMessageDirection === 'inbound' ? 'Cliente respondio' : 'Esperando respuesta'}>
                          {(conv.lastMessageDirection || 'outbound') === 'inbound' ? (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
                          ) : (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
                          )}
                        </span>
                        <p className="text-sm text-gray-400 truncate flex-1">{conv.lastMessage || 'Sin mensajes'}</p>
                        {contactTagsList.length > 0 && (
                          <div className="flex gap-1 flex-wrap flex-shrink-0">
                            {contactTagsList.slice(0, 3).map(tag => (
                              <span 
                                key={tag.id} 
                                className="text-xs px-1.5 py-0.5 rounded-full font-medium border transition-all hover:scale-105" 
                                style={{ 
                                  backgroundColor: `${tag.color}20`, 
                                  color: tag.color,
                                  borderColor: `${tag.color}40`
                                }}
                              >
                                {tag.name}
                              </span>
                            ))}
                            {contactTagsList.length > 3 && (
                              <span className="text-xs px-1.5 py-0.5 rounded-full bg-dark-hover text-gray-400">
                                +{contactTagsList.length - 3}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className={`${selectedPhone ? 'flex' : 'hidden sm:flex'} flex-1 flex-col min-w-0 overflow-hidden`}>
          {selectedPhone ? (
            <>
              <div className="border-b border-dark-border bg-dark-card">
                {/* Fila 1: Avatar, nombre y controles principales */}
                <div className="px-3 sm:px-4 py-2 flex items-center gap-2">
                  <button onClick={() => { setChatListOpen(true); setSelectedPhone(null); router.replace('/dashboard/chat', { scroll: false }); }} className="sm:hidden p-1.5 text-gray-400 hover:text-white transition-colors flex-shrink-0">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  </button>
                  <button onClick={() => setChatListOpen(!chatListOpen)} className="hidden sm:block p-1 text-gray-500 hover:text-white transition-colors flex-shrink-0">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {chatListOpen ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 5l7 7-7 7M5 5l7 7-7 7" />}
                    </svg>
                  </button>
                  <div className="w-10 h-10 bg-neon-blue/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <span className="text-neon-blue text-lg">👤</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-white truncate">{selectedContactName || `+${selectedPhone}`}</p>
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
                      <button 
                        onClick={handleToggleContactBot} 
                        disabled={contactBotToggling || !currentBusiness.botEnabled} 
                        title={!currentBusiness.botEnabled ? 'Bot desactivado globalmente' : contactBotDisabled ? 'Bot desactivado para este contacto' : 'Bot activo para este contacto'}
                        className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors flex-shrink-0 ${
                          contactBotDisabled 
                            ? 'bg-accent-error/20 text-accent-error' 
                            : currentBusiness.botEnabled 
                              ? 'bg-accent-success/20 text-accent-success' 
                              : 'bg-dark-hover text-gray-400'
                        }`}
                      >
                        {contactBotDisabled ? '🚫 Bot off' : currentBusiness.botEnabled ? '🤖 Bot' : '😴 Global off'}
                      </button>
                      {!currentBusiness.botEnabled && (
                        <button 
                          onClick={handleToggleBotTestMode} 
                          disabled={contactBotTestToggling} 
                          title={contactBotTestEnabled ? 'Modo testing activo - Bot responderá a este chat' : 'Activar modo testing para probar el bot'}
                          className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors flex-shrink-0 ${
                            contactBotTestEnabled 
                              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50' 
                              : 'bg-dark-hover text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-400'
                          }`}
                        >
                          {contactBotTestEnabled ? '🧪 Testing ON' : '🧪 Test'}
                        </button>
                      )}
                      <button 
                        onClick={handleToggleContactReminder} 
                        disabled={contactReminderToggling} 
                        title={contactRemindersPaused ? 'Recordatorios pausados para este contacto' : 'Recordatorios activos para este contacto'}
                        className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors flex-shrink-0 ${
                          contactRemindersPaused 
                            ? 'bg-accent-warning/20 text-accent-warning' 
                            : 'bg-purple-500/20 text-purple-400'
                        }`}
                      >
                        {contactRemindersPaused ? '⏸️ Rec off' : '🔔 Rec'}
                      </button>
                      {windowStatus && windowStatus.provider && ['META_CLOUD', 'META_COEXIST'].includes(windowStatus.provider) && (
                        <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${windowStatus.windowOpen ? 'bg-neon-blue/20 text-neon-blue' : 'bg-accent-warning/20 text-accent-warning'}`}>
                          {windowStatus.windowOpen ? `📬 ${windowStatus.hoursRemaining}h` : '📭 Template'}
                        </span>
                      )}
                      {instances.length > 1 && (selectedInstanceId || selectedConversationInstanceId) && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-dark-hover text-gray-300 flex-shrink-0" title="Enviando desde esta instancia">
                          📱 {instances.find((i: any) => i.id === (selectedInstanceId || selectedConversationInstanceId))?.name || 
                             instances.find((i: any) => i.id === (selectedInstanceId || selectedConversationInstanceId))?.phoneNumber?.slice(-4) || 
                             'WhatsApp'}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Botones de acción del header - siempre visibles a la derecha */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button 
                      onClick={() => setShowContactPanel(!showContactPanel)}
                      className={`p-2 rounded-full transition-colors ${showContactPanel ? 'bg-neon-blue/20 text-neon-blue' : 'text-gray-400 hover:text-white hover:bg-dark-hover'}`}
                      title="Datos del contacto"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </button>
                    {!isAdvisorMode && (
                      <button 
                        onClick={() => setShowDeleteConfirm(true)}
                        className="p-2 rounded-full transition-colors text-gray-400 hover:text-accent-error hover:bg-accent-error/10"
                        title="Eliminar conversacion y memoria del agente"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                
                {/* Fila 2: Etapas del funnel como filtro horizontal compacto */}
                {availableFunnelStages.length > 0 && (
                  <div className="px-2 py-1 flex items-center gap-1 border-t border-dark-border/30 overflow-x-auto scrollbar-none">
                    {availableFunnelStages.map((stage, index) => {
                      const isSelected = funnelStage?.id === stage.id;
                      const stageColors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
                      const color = stageColors[index % stageColors.length];
                      return (
                        <button
                          key={stage.id}
                          onClick={() => handleChangeFunnelStage(isSelected ? '' : stage.id)}
                          disabled={changingFunnelStage}
                          className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap transition-all flex-shrink-0 ${
                            isSelected 
                              ? 'font-semibold ring-1 ring-offset-1 ring-offset-dark-bg' 
                              : 'opacity-60 hover:opacity-100'
                          }`}
                          style={{ 
                            backgroundColor: isSelected ? color : `${color}20`,
                            color: isSelected ? '#fff' : color,
                            boxShadow: isSelected ? `0 0 0 2px ${color}40` : undefined
                          }}
                        >
                          {stage.name}
                        </button>
                      );
                    })}
                    {/* Asesor asignado - compacto */}
                    {!isAdvisorMode && getContactAdvisor(selectedPhone) && (
                      <span className="hidden sm:flex items-center gap-1 text-[10px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded-full flex-shrink-0 ml-auto">
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                        {getContactAdvisor(selectedPhone)?.name}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {showDeleteConfirm && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
                  <div className="bg-dark-card border border-dark-border rounded-lg p-6 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 bg-accent-error/20 rounded-full flex items-center justify-center">
                        <svg className="w-5 h-5 text-accent-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="font-semibold text-white">Eliminar Conversacion</h3>
                        <p className="text-sm text-gray-400">+{selectedPhone}</p>
                      </div>
                    </div>
                    <p className="text-gray-300 text-sm mb-4">
                      Esta accion eliminara todos los mensajes, datos extraidos del contacto, etapas del embudo y memoria del agente IA. El agente no recordara nada de esta conversacion.
                    </p>
                    <div className="space-y-2 mb-4 p-3 bg-dark-surface rounded-lg">
                      <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={deleteIncludeOrders} 
                          onChange={(e) => setDeleteIncludeOrders(e.target.checked)}
                          className="w-4 h-4 rounded border-dark-border bg-dark-card text-accent-error focus:ring-accent-error"
                        />
                        Incluir pedidos de este contacto
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={deleteIncludeAppointments} 
                          onChange={(e) => setDeleteIncludeAppointments(e.target.checked)}
                          className="w-4 h-4 rounded border-dark-border bg-dark-card text-accent-error focus:ring-accent-error"
                        />
                        Incluir citas de este contacto
                      </label>
                    </div>
                    <div className="flex gap-3 justify-end">
                      <button 
                        onClick={() => { setShowDeleteConfirm(false); setDeleteIncludeOrders(false); setDeleteIncludeAppointments(false); }}
                        className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                      >
                        Cancelar
                      </button>
                      <button 
                        onClick={handleDeleteConversation}
                        disabled={deletingConversation}
                        className="px-4 py-2 bg-accent-error text-white rounded-lg hover:bg-accent-error/80 transition-colors disabled:opacity-50"
                      >
                        {deletingConversation ? 'Eliminando...' : 'Eliminar Todo'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {showContactPanel && (
                <div className="px-4 py-3 border-b border-dark-border bg-dark-surface max-h-[50vh] flex flex-col">
                  <div className="flex items-center justify-between mb-3 flex-shrink-0">
                    <h4 className="text-sm font-medium text-white">Datos del Contacto</h4>
                    <div className="flex flex-col gap-2">
                      {/* Etapa del Embudo (automática) */}
                      {funnelStage && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400">Etapa del Embudo:</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30" title="Etapa del flujo de venta (automática)">
                            🎯 {funnelStage.name}
                          </span>
                        </div>
                      )}
                      {/* Etiquetas (manuales) - Compacto */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-gray-400 flex-shrink-0">Etiquetas:</span>
                        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
                          {getContactTags(selectedPhone).slice(0, 1).map(tag => (
                            <span 
                              key={tag.id}
                              className="text-[10px] px-1 py-0.5 rounded-full flex items-center gap-0.5 font-medium border transition-all hover:scale-105 flex-shrink-0"
                              style={{ 
                                backgroundColor: `${tag.color}15`, 
                                color: tag.color,
                                borderColor: `${tag.color}40`
                              }}
                            >
                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                              <span className="truncate max-w-[50px]">{tag.name}</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveTag(selectedPhone, tag.id);
                                }}
                                className="hover:bg-black/20 rounded-full p-0.5 transition-colors ml-0.5 flex-shrink-0"
                                title="Remover etiqueta"
                              >
                                <svg className="w-2 h-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </span>
                          ))}
                          {getContactTags(selectedPhone).length > 1 && (
                            <span className="text-[10px] px-1 py-0.5 rounded-full bg-dark-hover text-gray-400 flex-shrink-0">
                              +{getContactTags(selectedPhone).length - 1}
                            </span>
                          )}
                          <TagQuickAdd
                            phone={selectedPhone}
                            currentTags={getContactTags(selectedPhone)}
                            onOpen={(element) => {
                              setTagQuickAddRef({ phone: selectedPhone, element });
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  {extractedFields.length > 0 ? (
                    <div className="overflow-y-auto flex-1 pr-1 scrollbar-thin scrollbar-track-dark-bg scrollbar-thumb-dark-border">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                        {extractedFields.map((field) => (
                          <div key={field.fieldKey} className="flex items-start gap-2 text-xs py-1 border-b border-dark-border/30 last:border-0">
                            <span className="text-gray-500 min-w-[90px] flex-shrink-0 truncate" title={field.fieldLabel}>{field.fieldLabel}:</span>
                            {editingField === field.fieldKey ? (
                              <div className="flex-1 flex items-center gap-1">
                                <input
                                  type="text"
                                  value={editingValue}
                                  onChange={(e) => setEditingValue(e.target.value)}
                                  className="flex-1 px-2 py-1 bg-dark-card border border-dark-border rounded text-white text-xs focus:outline-none focus:border-neon-blue"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveExtractedField(field.fieldKey, editingValue);
                                    if (e.key === 'Escape') { setEditingField(null); setEditingValue(''); }
                                  }}
                                />
                                <button
                                  onClick={() => handleSaveExtractedField(field.fieldKey, editingValue)}
                                  disabled={savingField}
                                  className="p-1 text-accent-success hover:bg-accent-success/20 rounded"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                </button>
                                <button
                                  onClick={() => { setEditingField(null); setEditingValue(''); }}
                                  className="p-1 text-gray-400 hover:bg-dark-hover rounded"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>
                            ) : (
                              <div className="flex-1 flex items-center gap-1 group min-w-0">
                                <span className={`truncate ${field.value ? 'text-white' : 'text-gray-600 italic'}`} title={field.value || 'Sin datos'}>{field.value || 'Sin datos'}</span>
                                {field.source === 'manual' && <span className="text-[9px] text-accent-success flex-shrink-0">manual</span>}
                                {field.source === 'tool' && <span className="text-[9px] text-purple-400 flex-shrink-0">tool</span>}
                                <button
                                  onClick={() => { setEditingField(field.fieldKey); setEditingValue(field.value || ''); }}
                                  className="ml-auto p-1 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-neon-blue transition-all flex-shrink-0"
                                  title="Editar"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">Sin campos configurados. Configura campos en Datos Personalizados.</p>
                  )}
                </div>
              )}

              <div 
                className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2 scroll-smooth-ios scrollbar-thin bg-dark-bg"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const threshold = 50;
                  isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
                }}
              >
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`chat-bubble ${msg.direction === 'outbound' ? 'chat-bubble-outgoing' : 'chat-bubble-incoming'} ${msg.metadata?.pending ? 'opacity-70' : ''}`}>
                      {msg.mediaUrl && renderMedia(msg.mediaUrl, msg.direction === 'outbound', msg.metadata?.mediaType || msg.metadata?.type)}
                      {!msg.mediaUrl && msg.metadata?.mediaPending && (
                        <div className="flex items-center gap-2 text-gray-400 text-sm py-2">
                          <div className="animate-spin w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full"></div>
                          <span>
                            {msg.metadata?.mediaType === 'image' || msg.metadata?.type === 'image' ? 'Cargando imagen...' :
                             msg.metadata?.mediaType === 'video' || msg.metadata?.type === 'video' ? 'Cargando video...' :
                             msg.metadata?.mediaType === 'audio' || msg.metadata?.type === 'audio' || msg.metadata?.type === 'ptt' ? 'Cargando audio...' :
                             msg.metadata?.mediaType === 'document' || msg.metadata?.type === 'document' ? 'Cargando documento...' :
                             'Cargando multimedia...'}
                          </span>
                        </div>
                      )}
                      {!msg.mediaUrl && !msg.metadata?.mediaPending && (msg.metadata?.mediaType || msg.metadata?.type) && !msg.message && (
                        <div className="flex items-center gap-2 text-red-400 text-sm py-2">
                          <span>
                            {msg.metadata?.mediaType === 'image' || msg.metadata?.type === 'image' ? '🖼️ Imagen' :
                             msg.metadata?.mediaType === 'video' || msg.metadata?.type === 'video' ? '🎬 Video' :
                             msg.metadata?.mediaType === 'audio' || msg.metadata?.type === 'audio' || msg.metadata?.type === 'ptt' ? '🎤 Audio' :
                             msg.metadata?.mediaType === 'document' || msg.metadata?.type === 'document' ? '📄 Documento' :
                             msg.metadata?.mediaType === 'sticker' || msg.metadata?.type === 'sticker' ? '😀 Sticker' :
                             '📎 Archivo'}
                          </span>
                          <span className="text-xs opacity-70">(no disponible)</span>
                        </div>
                      )}
                      {msg.message && (
                        <p className="break-words whitespace-pre-wrap text-sm sm:text-base">
                          {/* Filter out the Gemini analysis from message text if it exists in metadata */}
                          {msg.metadata?.mediaAnalysis 
                            ? msg.message.split(msg.metadata.mediaAnalysis)[0].replace(/\n\n$/, '').trim() || msg.message
                            : msg.message}
                        </p>
                      )}
                      {msg.direction === 'inbound' && msg.metadata?.mediaAnalysis && (
                        <div className="mt-1 group relative inline-block">
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-purple-500/30 text-purple-300 rounded cursor-help font-medium">
                            <span>✨</span>
                            <span>Analizado</span>
                          </span>
                          <div className="absolute bottom-full left-0 mb-1 w-56 sm:w-64 p-2.5 bg-gray-900/95 border border-purple-500/40 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 backdrop-blur-sm">
                            <p className="text-[11px] text-purple-300 font-semibold mb-1">
                              {msg.metadata?.mediaType === 'audio' || msg.metadata?.type === 'audio' || msg.metadata?.type === 'ptt' ? '🎤 Transcripción:' : 
                               msg.metadata?.mediaType === 'image' || msg.metadata?.type === 'image' || msg.metadata?.type === 'sticker' ? '🖼️ Descripción:' : 
                               msg.metadata?.mediaType === 'video' || msg.metadata?.type === 'video' ? '🎬 Descripción:' : '📎 Análisis:'}
                            </p>
                            <p className="text-[11px] text-gray-200 whitespace-pre-wrap max-h-32 overflow-y-auto leading-relaxed">
                              {msg.metadata.mediaAnalysis}
                            </p>
                          </div>
                        </div>
                      )}
                      <p className={`text-xs mt-1 text-right ${msg.direction === 'outbound' ? 'text-neon-blue-dark' : 'text-gray-500'}`}>
                        {(msg.metadata?.isTemplate || msg.metadata?.templateName) && (
                          <span className="mr-2 px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded text-[10px] font-medium">
                            Plantilla
                          </span>
                        )}
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
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="flex-shrink-0 p-2.5 text-gray-400 hover:text-white hover:bg-dark-hover rounded-full transition-colors" disabled={sending || (['META_CLOUD', 'META_COEXIST'].includes(windowStatus?.provider || '') && !windowStatus?.windowOpen)}>
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  </button>
                  <button type="button" onClick={isRecording ? handleStopRecording : handleStartRecording} className={`flex-shrink-0 p-2.5 rounded-full transition-colors ${isRecording ? 'bg-accent-error text-white animate-pulse' : 'text-gray-400 hover:text-white hover:bg-dark-hover'}`} disabled={(sending && !isRecording) || (['META_CLOUD', 'META_COEXIST'].includes(windowStatus?.provider || '') && !windowStatus?.windowOpen)}>
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                  </button>
                  <input 
                    ref={inputRef}
                    type="text" 
                    value={newMessage} 
                    onChange={(e) => setNewMessage(e.target.value)} 
                    onFocus={handleInputFocus}
                    onBlur={handleInputBlur}
                    placeholder={['META_CLOUD', 'META_COEXIST'].includes(windowStatus?.provider || '') && !windowStatus?.windowOpen ? "Ventana cerrada - usa plantilla" : "Escribe un mensaje..."} 
                    className="flex-1 min-w-0 px-4 py-2.5 bg-dark-surface border border-dark-border rounded-full text-white placeholder-gray-500 focus:outline-none focus:border-neon-blue focus:ring-1 focus:ring-neon-blue/50 text-sm sm:text-base" 
                    disabled={sending || (['META_CLOUD', 'META_COEXIST'].includes(windowStatus?.provider || '') && !windowStatus?.windowOpen)}
                    enterKeyHint="send"
                    autoComplete="off"
                    autoCorrect="on"
                  />
                  {['META_CLOUD', 'META_COEXIST'].includes(windowStatus?.provider || '') && !windowStatus?.windowOpen ? (
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

              {['META_CLOUD', 'META_COEXIST'].includes(instanceProvider || '') && newChatTemplates.length > 0 && (
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
                    Usar plantilla (Meta)
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

              {['META_CLOUD', 'META_COEXIST'].includes(instanceProvider || '') && (
                <p className="text-xs text-gray-500 text-center">
                  Para numeros nuevos, usa una plantilla aprobada
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {showTeamPanel && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowTeamPanel(false)}>
          <div className="bg-dark-card rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-dark-border flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Equipo de Asesores</h3>
              <button onClick={() => setShowTeamPanel(false)} className="p-1 text-gray-400 hover:text-white">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            
            <div className="p-4 border-b border-dark-border">
              <form onSubmit={handleInviteAdvisor} className="flex gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="Email del asesor a invitar..."
                  className="flex-1 px-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-neon-blue"
                />
                <button 
                  type="submit" 
                  disabled={inviting || !inviteEmail.trim()}
                  className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg font-medium hover:bg-neon-blue-light disabled:opacity-50 transition-colors text-sm"
                >
                  {inviting ? '...' : 'Invitar'}
                </button>
              </form>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingTeam ? (
                <div className="text-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-neon-blue mx-auto" />
                </div>
              ) : (
                <>
                  {invitations.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-2">Invitaciones pendientes</h4>
                      <div className="space-y-2">
                        {invitations.map(inv => (
                          <div key={inv.id} className="flex items-center justify-between p-3 bg-dark-surface rounded-lg">
                            <div>
                              <p className="text-white text-sm">{inv.email}</p>
                              <p className="text-xs text-gray-500">Expira: {new Date(inv.expiresAt).toLocaleDateString()}</p>
                            </div>
                            <button 
                              onClick={() => handleCancelInvitation(inv.id)}
                              className="text-xs text-accent-error hover:underline"
                            >
                              Cancelar
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Asesores activos ({advisors.length})</h4>
                    {advisors.length === 0 ? (
                      <p className="text-sm text-gray-500 py-4 text-center">No hay asesores en tu equipo</p>
                    ) : (
                      <div className="space-y-2">
                        {advisors.map(advisor => (
                          <div key={advisor.id} className="flex items-center justify-between p-3 bg-dark-surface rounded-lg">
                            <div>
                              <p className="text-white text-sm font-medium">{advisor.name}</p>
                              <p className="text-xs text-gray-500">{advisor.email}</p>
                              <p className="text-xs text-gray-500">{advisor._count.contactAssignments} contactos asignados</p>
                            </div>
                            <button 
                              onClick={() => handleRemoveAdvisor(advisor.id)}
                              className="p-1.5 text-gray-400 hover:text-accent-error transition-colors"
                              title="Eliminar asesor"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {advisors.length > 0 && (
                    <div className="pt-4 border-t border-dark-border">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h4 className="text-sm font-medium text-white">Asignacion rotativa</h4>
                          <p className="text-xs text-gray-500">Asigna nuevos leads automaticamente entre asesores seleccionados</p>
                        </div>
                        <button
                          onClick={handleToggleRoundRobin}
                          disabled={savingRoundRobin || roundRobinAdvisors.length === 0}
                          className={`relative w-11 h-6 rounded-full transition-colors ${
                            roundRobinEnabled ? 'bg-neon-blue' : 'bg-dark-surface'
                          } ${savingRoundRobin || roundRobinAdvisors.length === 0 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                            roundRobinEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`} />
                        </button>
                      </div>
                      <div className="space-y-2">
                        {advisors.map(advisor => (
                          <div 
                            key={advisor.id} 
                            className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${
                              roundRobinAdvisors.includes(advisor.id) ? 'bg-neon-blue/10' : 'bg-dark-surface hover:bg-dark-hover'
                            }`}
                          >
                            <label className="flex items-center gap-3 flex-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={roundRobinAdvisors.includes(advisor.id)}
                                onChange={() => handleToggleRoundRobinAdvisor(advisor.id)}
                                disabled={savingRoundRobin}
                                className="w-4 h-4 rounded border-dark-border bg-dark-surface text-neon-blue focus:ring-neon-blue focus:ring-offset-0"
                              />
                              <span className="text-sm text-white">{advisor.name}</span>
                            </label>
                            {roundRobinAdvisors.includes(advisor.id) && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-gray-400">Capacidad:</span>
                                <input
                                  type="number"
                                  min="1"
                                  max="10"
                                  value={roundRobinWeights[advisor.id] || 1}
                                  onChange={(e) => handleUpdateAdvisorWeight(advisor.id, parseInt(e.target.value) || 1)}
                                  disabled={savingRoundRobin}
                                  className="w-14 px-2 py-1 bg-dark-surface border border-dark-border rounded text-white text-sm text-center focus:outline-none focus:border-neon-blue"
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-gray-500">
                        La capacidad (1-10) determina cuantos leads recibe cada asesor. Un asesor con capacidad 3 recibe 3x mas leads que uno con capacidad 1.
                      </p>
                      {roundRobinEnabled && roundRobinAdvisors.length > 0 && (
                        <p className="mt-2 text-xs text-accent-success">
                          Activo: Los nuevos leads se asignaran entre {roundRobinAdvisors.length} asesor{roundRobinAdvisors.length > 1 ? 'es' : ''} segun su capacidad
                        </p>
                      )}
                    </div>
                  )}

                  {advisors.length > 0 && selectedPhone && (
                    <div className="pt-4 border-t border-dark-border">
                      <h4 className="text-sm font-medium text-gray-400 mb-2">Asignar conversacion actual</h4>
                      <p className="text-xs text-gray-500 mb-2">Contacto: {selectedContactName || selectedPhone}</p>
                      <select
                        value={getContactAdvisor(selectedPhone)?.id || ''}
                        onChange={(e) => handleAssignContact(selectedPhone, e.target.value)}
                        className="w-full px-3 py-2 bg-dark-surface border border-dark-border rounded-lg text-white text-sm focus:outline-none focus:border-neon-blue"
                      >
                        <option value="">Sin asignar</option>
                        {advisors.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Menú contextual (click derecho) */}
      {contextMenu && (
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={closeContextMenu}
          />
          <div
            className="fixed z-50 bg-dark-card border border-dark-border rounded-lg shadow-xl min-w-[200px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setTagDropdownPhone(contextMenu.phone);
                  setTagDropdownPosition({ x: contextMenu.x + 200, y: contextMenu.y });
                  setShowTagDropdown(true);
                }}
                className="w-full text-left px-3 py-2 text-sm text-white hover:bg-dark-hover rounded transition-colors flex items-center justify-between"
              >
                <span>Asignar etiqueta</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                onClick={() => {
                  setShowCreateTagModal(true);
                  closeContextMenu();
                }}
                className="w-full text-left px-3 py-2 text-sm text-white hover:bg-dark-hover rounded transition-colors"
              >
                Crear nueva etiqueta...
              </button>
              {getContactTags(contextMenu.phone).length > 0 && (
                <>
                  <div className="border-t border-dark-border my-1" />
                  <div className="px-2 py-1 text-xs text-gray-400">Etiquetas actuales:</div>
                  {getContactTags(contextMenu.phone).map(tag => (
                    <button
                      key={tag.id}
                      onClick={() => {
                        handleRemoveTag(contextMenu.phone, tag.id);
                        closeContextMenu();
                      }}
                      className="w-full text-left px-3 py-2 text-sm rounded transition-colors flex items-center gap-2 hover:bg-dark-hover"
                      style={{ color: tag.color }}
                    >
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                      <span>Remover "{tag.name}"</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Dropdown para TagQuickAdd */}
      {tagQuickAddRef && tagQuickAddRef.element && (
        <TagDropdown
          phone={tagQuickAddRef.phone}
          position={(() => {
            try {
              if (tagQuickAddRef.element && typeof window !== 'undefined') {
                const rect = tagQuickAddRef.element.getBoundingClientRect();
                return { x: rect.left, y: rect.bottom + 4 };
              }
            } catch (e) {
              console.error('Error getting button position:', e);
            }
            return { x: 0, y: 0 };
          })()}
          currentTags={getContactTags(tagQuickAddRef.phone)}
          onAssign={async (tagId: string) => {
            await handleAssignTag(tagQuickAddRef.phone, tagId);
          }}
          onRemove={async (tagId: string) => {
            await handleRemoveTag(tagQuickAddRef.phone, tagId);
          }}
          onClose={() => {
            setTagQuickAddRef(null);
          }}
        />
      )}

      {/* Dropdown para menú contextual de asignar etiqueta */}
      {showTagDropdown && tagDropdownPhone && tagDropdownPosition && (
        <TagDropdown
          phone={tagDropdownPhone}
          position={tagDropdownPosition}
          currentTags={getContactTags(tagDropdownPhone)}
          onAssign={async (tagId: string) => {
            await handleAssignTag(tagDropdownPhone, tagId);
          }}
          onRemove={async (tagId: string) => {
            await handleRemoveTag(tagDropdownPhone, tagId);
          }}
          onClose={() => {
            setShowTagDropdown(false);
            setTagDropdownPhone(null);
            setTagDropdownPosition(null);
          }}
        />
      )}

      {/* Modal para crear etiqueta */}
      {showCreateTagModal && (
        <CreateTagModal
          onClose={() => setShowCreateTagModal(false)}
          onSuccess={async () => {
            await fetchTags();
            setShowCreateTagModal(false);
          }}
        />
      )}

    </div>
  );
}

// Componente modal para crear etiqueta
function CreateTagModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { currentBusiness } = useBusinessStore();
  const { selectedInstanceId } = useInstanceStore();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6B7280');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const presetColors = [
    '#22C55E', '#3B82F6', '#EAB308', '#F97316', '#10B981',
    '#6B7280', '#8B5CF6', '#EC4899', '#14B8A6', '#F59E0B'
  ];

  const handleCreate = async () => {
    if (!name.trim() || !currentBusiness) return;
    setCreating(true);
    try {
      await tagsApi.create({
        business_id: currentBusiness.id,
        instance_id: selectedInstanceId || undefined,
        name: name.trim(),
        color,
        description: description.trim() || undefined
      });
      onSuccess();
    } catch (err) {
      console.error('Failed to create tag:', err);
      alert('Error al crear etiqueta');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-dark-card border border-dark-border rounded-lg p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">Crear Nueva Etiqueta</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: VIP, Urgente, etc."
              className="w-full px-3 py-2 bg-dark-surface border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">Color</label>
            <div className="flex gap-2 flex-wrap">
              {presetColors.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-full border-2 transition-all ${color === c ? 'border-white scale-110' : 'border-dark-border'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="mt-2 w-full h-10 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Descripción (opcional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descripción de la etiqueta..."
              rows={2}
              className="w-full px-3 py-2 bg-dark-surface border border-dark-border rounded text-white text-sm focus:outline-none focus:border-neon-blue resize-none"
            />
          </div>
        </div>
        <div className="flex gap-3 justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="px-4 py-2 bg-neon-blue text-dark-bg rounded-lg font-medium hover:bg-neon-blue-light disabled:opacity-50 transition-colors"
          >
            {creating ? 'Creando...' : 'Crear'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Componente dropdown fluido para asignar etiquetas
function TagDropdown({ 
  phone, 
  position, 
  currentTags, 
  onClose, 
  onAssign, 
  onRemove 
}: { 
  phone: string; 
  position: { x: number; y: number };
  currentTags: Tag[]; 
  onClose: () => void; 
  onAssign: (tagId: string) => Promise<void>; 
  onRemove: (tagId: string) => Promise<void>;
}) {
  const { currentBusiness } = useBusinessStore();
  const { selectedInstanceId } = useInstanceStore();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchTags = async () => {
      if (!currentBusiness) return;
      try {
        const res = await tagsApi.list(currentBusiness.id, selectedInstanceId || undefined);
        setTags(res.data);
      } catch (err) {
        console.error('Failed to fetch tags:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchTags();
  }, [currentBusiness, selectedInstanceId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const currentTagIds = new Set(currentTags.map(t => t.id));

  // Ajustar posición si el dropdown se sale de la pantalla (responsive)
  const adjustedPosition = useMemo(() => {
    if (typeof window === 'undefined') return position;
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const isMobile = viewportWidth < 640; // sm breakpoint
    
    let x = position.x;
    let y = position.y;
    const dropdownWidth = isMobile ? Math.min(280, viewportWidth - 20) : 320;
    const dropdownHeight = 400; // max height

    // Ajustar horizontalmente
    if (x + dropdownWidth > viewportWidth) {
      x = Math.max(10, viewportWidth - dropdownWidth - 10);
    }
    if (x < 10) x = 10;

    // Ajustar verticalmente
    if (y + dropdownHeight > viewportHeight) {
      y = Math.max(10, viewportHeight - dropdownHeight - 10);
    }
    if (y < 10) y = 10;

    return { x, y };
  }, [position]);

  return (
    <>
      <div 
        className="fixed inset-0 z-45" 
        onClick={onClose}
      />
      <div
        ref={dropdownRef}
        className="fixed z-50 bg-dark-card border border-dark-border rounded-lg shadow-2xl w-[280px] sm:w-[320px] max-h-[400px] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
        style={{ 
          left: `${adjustedPosition.x}px`, 
          top: `${adjustedPosition.y}px`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-2">
          <div className="px-2 py-1.5 mb-1 border-b border-dark-border">
            <h4 className="text-sm font-semibold text-white">Asignar Etiquetas</h4>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-neon-blue" />
            </div>
          ) : (
            <div className="overflow-y-auto max-h-[320px] space-y-0.5">
              {tags.map(tag => {
                const isAssigned = currentTagIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={async () => {
                      if (isAssigned) {
                        await onRemove(tag.id);
                      } else {
                        await onAssign(tag.id);
                      }
                    }}
                    className={`w-full text-left px-3 py-2 rounded flex items-center justify-between transition-all duration-150 ${
                      isAssigned 
                        ? 'bg-opacity-20' 
                        : 'hover:bg-dark-hover'
                    }`}
                    style={{
                      backgroundColor: isAssigned ? `${tag.color}25` : 'transparent',
                      color: isAssigned ? tag.color : 'white'
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <div 
                        className="w-3 h-3 rounded-full flex-shrink-0 border border-dark-border" 
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="text-sm">{tag.name}</span>
                    </div>
                    {isAssigned && (
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
              {tags.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No hay etiquetas disponibles</p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Componente TagQuickAdd para botón "+" reutilizable
function TagQuickAdd({
  phone,
  currentTags,
  onOpen
}: {
  phone: string;
  currentTags: Tag[];
  onOpen: (element: HTMLElement) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (buttonRef.current) {
      // Usar setTimeout para asegurar que el DOM esté actualizado
      setTimeout(() => {
        if (buttonRef.current) {
          onOpen(buttonRef.current);
        }
      }, 0);
    }
  };

  return (
    <button
      ref={buttonRef}
      onClick={handleClick}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="text-[10px] px-1 py-0.5 rounded-full bg-dark-hover text-gray-400 hover:text-white hover:bg-dark-border transition-all duration-150 hover:scale-105 flex-shrink-0"
      title="Agregar etiqueta"
      type="button"
    >
      +
    </button>
  );
}

// Componente KanbanColumn para vista Kanban
function KanbanColumn({
  title,
  color,
  conversations,
  onSelectConversation,
  selectedPhone,
  onContextMenu,
  getContactTags,
  formatDate
}: {
  title: string;
  color: string;
  conversations: Conversation[];
  onSelectConversation: (phone: string, contactName: string, instanceId: string | null) => void;
  selectedPhone: string | null;
  onContextMenu: (e: React.MouseEvent, phone: string, contactName: string) => void;
  getContactTags: (phone: string) => Tag[];
  formatDate: (date: string) => string;
}) {
  return (
    <div className="flex-shrink-0 w-52 sm:w-60 lg:w-64 bg-dark-surface rounded-lg border border-dark-border flex flex-col" style={{ height: '100%', minHeight: '500px', maxHeight: 'calc(100vh - 140px)' }}>
      {/* Header de la columna */}
      <div 
        className="px-3 py-2.5 border-b border-dark-border flex items-center justify-between sticky top-0 bg-dark-surface rounded-t-lg z-10"
        style={{ borderBottomColor: `${color}30` }}
      >
        <div className="flex items-center gap-2">
          <div 
            className="w-3 h-3 rounded-full flex-shrink-0 border border-dark-border" 
            style={{ backgroundColor: color }}
          />
          <h3 className="text-sm font-semibold text-white">{title}</h3>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-dark-hover text-gray-400">
          {conversations.length}
        </span>
      </div>
      
      {/* Lista de conversaciones */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {conversations.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-xs">
            Sin conversaciones
          </div>
        ) : (
          conversations.map((conv) => {
            const contactTagsList = getContactTags(conv.phone);
            return (
              <button
                key={conv.phone}
                onClick={() => onSelectConversation(conv.phone, conv.contactName || '', conv.instanceId || null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(e, conv.phone, conv.contactName || '');
                }}
                className={`w-full p-3 text-left bg-dark-card rounded-lg border border-dark-border hover:border-opacity-60 transition-all duration-150 hover:shadow-lg ${
                  selectedPhone === conv.phone ? 'border-neon-blue bg-neon-blue/10' : ''
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <div className="w-10 h-10 bg-dark-surface rounded-full flex items-center justify-center flex-shrink-0 relative">
                    <span className="text-lg">👤</span>
                    {contactTagsList.length > 0 && (
                      <div 
                        className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-dark-surface" 
                        style={{ backgroundColor: contactTagsList[0].color }} 
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-medium text-white truncate text-sm">{conv.contactName || `+${conv.phone}`}</p>
                      <span className="text-xs text-gray-500 flex-shrink-0 ml-2">{formatDate(conv.lastMessageAt)}</span>
                    </div>
                    <p className="text-xs text-gray-400 truncate mb-2">{conv.lastMessage || 'Sin mensajes'}</p>
                    <div className="flex items-center gap-1.5">
                      <span className={`flex-shrink-0 ${(conv.lastMessageDirection || 'outbound') === 'inbound' ? 'text-accent-success' : 'text-gray-500'}`} title={conv.lastMessageDirection === 'inbound' ? 'Cliente respondio' : 'Esperando respuesta'}>
                        {(conv.lastMessageDirection || 'outbound') === 'inbound' ? (
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
                        ) : (
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
                        )}
                      </span>
                      {contactTagsList.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {contactTagsList.slice(0, 2).map(tag => (
                            <span 
                              key={tag.id} 
                              className="text-xs px-1.5 py-0.5 rounded-full font-medium" 
                              style={{ 
                                backgroundColor: `${tag.color}25`, 
                                color: tag.color,
                                border: `1px solid ${tag.color}40`
                              }}
                            >
                              {tag.name}
                            </span>
                          ))}
                          {contactTagsList.length > 2 && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-dark-hover text-gray-400">
                              +{contactTagsList.length - 2}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
