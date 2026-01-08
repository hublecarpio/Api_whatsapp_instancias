'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useBusinessStore } from '@/store/business';
import { messageApi, waApi, tagsApi } from '@/lib/api';
import { ArrowLeft, MessageSquare, Search, User, Clock, Tag as TagIcon } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface Conversation {
  phone: string;
  contactName: string;
  lastMessage: string | null;
  lastMessageAt: string;
  messageCount: number;
  instanceId?: string | null;
}

interface WhatsAppInstance {
  id: string;
  instanceNumber: number;
  name: string;
  provider: string;
  phoneNumber: string | null;
  status: string;
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface TagAssignment {
  tagId: string;
  contactPhone: string;
  tag: Tag;
}

export default function InstanceChatsPage() {
  const router = useRouter();
  const params = useParams();
  const instanceNumber = parseInt(params.instanceNumber as string, 10);
  const { currentBusiness } = useBusinessStore();
  
  const [instance, setInstance] = useState<WhatsAppInstance | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [assignments, setAssignments] = useState<TagAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  useEffect(() => {
    if (currentBusiness?.id && instanceNumber) {
      loadInstanceAndConversations();
    }
  }, [currentBusiness?.id, instanceNumber]);

  const loadInstanceAndConversations = async () => {
    if (!currentBusiness?.id) return;
    
    try {
      setLoading(true);
      
      const instancesResponse = await waApi.getInstances(currentBusiness.id);
      const foundInstance = instancesResponse.data?.find(
        (i: WhatsAppInstance) => i.instanceNumber === instanceNumber
      );
      
      if (!foundInstance) {
        router.push('/dashboard/chats');
        return;
      }
      
      setInstance(foundInstance);
      
      const [conversationsRes, tagsRes, assignmentsRes] = await Promise.all([
        messageApi.getConversationsByInstance(currentBusiness.id, foundInstance.id),
        tagsApi.getTags(currentBusiness.id).catch(() => ({ data: [] })),
        tagsApi.getAssignments(currentBusiness.id).catch(() => ({ data: [] }))
      ]);
      
      setConversations(conversationsRes.data || []);
      setTags(tagsRes.data || []);
      setAssignments(assignmentsRes.data || []);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  const getTagsForContact = (phone: string) => {
    return assignments
      .filter(a => a.contactPhone === phone)
      .map(a => a.tag);
  };

  const filteredConversations = conversations.filter(conv => {
    const matchesSearch = !searchQuery || 
      conv.contactName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conv.phone.includes(searchQuery);
    
    const matchesTag = !selectedTag || 
      assignments.some(a => a.contactPhone === conv.phone && a.tagId === selectedTag);
    
    return matchesSearch && matchesTag;
  });

  const handleSelectConversation = (conv: Conversation) => {
    const conversationId = conv.phone.replace(/\D/g, '');
    router.push(`/dashboard/chats/${instanceNumber}/${conversationId}`);
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
          onClick={() => router.push('/dashboard/chats')}
          className="p-2 hover:bg-gray-700 rounded-lg transition"
        >
          <ArrowLeft className="w-5 h-5 text-gray-400" />
        </button>
        
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-cyan-600/20 flex items-center justify-center">
            <span className="text-lg font-bold text-cyan-400">{instanceNumber}</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">
              {instance?.name || `WhatsApp ${instanceNumber}`}
            </h1>
            <p className="text-sm text-gray-400">{instance?.phoneNumber || 'Cargando...'}</p>
          </div>
        </div>
      </div>

      <div className="p-4 border-b border-gray-700 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Buscar por nombre o numero..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        {tags.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2">
            <button
              onClick={() => setSelectedTag(null)}
              className={`px-3 py-1 rounded-full text-sm whitespace-nowrap transition ${
                !selectedTag 
                  ? 'bg-cyan-600 text-white' 
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              Todos
            </button>
            {tags.map(tag => (
              <button
                key={tag.id}
                onClick={() => setSelectedTag(tag.id)}
                className={`px-3 py-1 rounded-full text-sm whitespace-nowrap transition flex items-center gap-1 ${
                  selectedTag === tag.id 
                    ? 'bg-cyan-600 text-white' 
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                <span 
                  className="w-2 h-2 rounded-full" 
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-gray-400">
            <MessageSquare className="w-12 h-12 mb-4 opacity-50" />
            <p>{searchQuery || selectedTag ? 'No se encontraron conversaciones' : 'No hay conversaciones aun'}</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {filteredConversations.map((conv) => {
              const contactTags = getTagsForContact(conv.phone);
              return (
                <div
                  key={conv.phone}
                  onClick={() => handleSelectConversation(conv)}
                  className="p-4 hover:bg-gray-800 cursor-pointer transition"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0">
                      <User className="w-6 h-6 text-gray-400" />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="font-medium text-white truncate">
                          {conv.contactName || conv.phone}
                        </h3>
                        <span className="text-xs text-gray-500 flex items-center gap-1 flex-shrink-0 ml-2">
                          <Clock className="w-3 h-3" />
                          {formatDistanceToNow(new Date(conv.lastMessageAt), { 
                            addSuffix: true,
                            locale: es 
                          })}
                        </span>
                      </div>
                      
                      <p className="text-sm text-gray-400 truncate mb-2">
                        {conv.lastMessage || 'Sin mensajes'}
                      </p>
                      
                      {contactTags.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {contactTags.map(tag => (
                            <span 
                              key={tag.id}
                              className="px-2 py-0.5 rounded text-xs flex items-center gap-1"
                              style={{ 
                                backgroundColor: `${tag.color}20`,
                                color: tag.color 
                              }}
                            >
                              <TagIcon className="w-3 h-3" />
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    
                    <div className="flex-shrink-0">
                      <span className="bg-gray-700 text-gray-300 text-xs px-2 py-1 rounded">
                        {conv.messageCount}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
