/**
 * admin/messaging.tsx — Phase 5b rewrite
 *
 * AMENDMENT 4:
 *   • Auto-scroll fix: new messages now reliably scroll to bottom using
 *     onContentSizeChange + scrollToEnd with animated: true
 *   • Add Call button in chat header to initiate phone calls
 *   • Search already supports name/email/phone with role filter pills
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, TextInput, Alert, Modal,
  KeyboardAvoidingView, Platform, RefreshControl,
  BackHandler, Image, Linking} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';


type Tab = 'search' | 'conversations';

export default function AdminMessaging() {
  const router = useRouter();
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/admin/dashboard');
      return true;
    });
    return () => sub.remove();
  }, []);

  const [tab, setTab] = useState<Tab>('search');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [roleFilter, setRoleFilter] = useState<'all' | 'civil' | 'security'>('all');
  const searchTimer = useRef<any>(null);

  // Selected user / compose
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [messageContent, setMessageContent] = useState('');
  const [sending, setSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);

  // Conversations list
  const [conversations, setConversations] = useState<any[]>([]);
  const [convsLoading, setConvsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Total unread count across all conversations (for tab badge)
  const totalUnread = conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0);

  // Chat view
  const [activeConv, setActiveConv] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [chatMsg, setChatMsg] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const chatListRef = useRef<FlatList>(null);
  const prevMessagesLength = useRef<number>(0);

  useEffect(() => {
    loadAllUsers();
    loadConversations();
  }, []);

  // ── Real-time search with debounce ────────────────────────────────────────
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) {
      setSearchResults(filterUsers(allUsers, '', roleFilter));
      return;
    }
    searchTimer.current = setTimeout(() => {
      performSearch(searchQuery.trim());
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQuery, roleFilter, allUsers]);

  const filterUsers = (users: any[], q: string, role: string) => {
    let out = users.filter(u => u.role !== 'admin');
    if (role !== 'all') out = out.filter(u => u.role === role);
    if (q) {
      const lq = q.toLowerCase();
      out = out.filter(u =>
        u.full_name?.toLowerCase().includes(lq) ||
        u.email?.toLowerCase().includes(lq) ||
        u.phone?.includes(q)
      );
    }
    return out;
  };

  const performSearch = (q: string) => {
    setSearching(true);
    try {
      setSearchResults(filterUsers(allUsers, q, roleFilter));
    } finally {
      setSearching(false);
    }
  };

  const loadAllUsers = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/admin/login'); return; }
      const res = await axios.get(`${BACKEND_URL}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      });
      const users = (res.data || []).filter((u: any) => u.role !== 'admin');
      setAllUsers(users);
      setSearchResults(filterUsers(users, '', 'all'));
    } catch (err: any) {
      if (err?.response?.status === 401 || err?.response?.status === 403) {
        await clearAuthData(); router.replace('/admin/login');
      }
    }
  };

  const loadConversations = async () => {
    setConvsLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) return;
      const res = await axios.get(`${BACKEND_URL}/api/chat/conversations`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      });
      setConversations(res.data?.conversations || []);
    } catch (_) {}
    finally { setConvsLoading(false); }
  };

  const onRefresh = async () => { setRefreshing(true); await loadConversations(); setRefreshing(false); };

  // ── AMENDMENT 4: Mark a conversation as read ──────────────────────────────
  const markConversationRead = async (convId: string) => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      await axios.post(
        `${BACKEND_URL}/api/chat/mark-read`,
        { conversation_id: convId },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
      );
      // Optimistically clear the unread badge in the local list
      setConversations(prev =>
        prev.map(c => c.id === convId ? { ...c, unread_count: 0 } : c)
      );
    } catch (_) {
      // Non-fatal — the badge will clear on the next conversations refresh
    }
  };

  // ── Start / open chat ─────────────────────────────────────────────────────
  const openChatWithUser = async (user: any) => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      const res = await axios.post(
        `${BACKEND_URL}/api/chat/start`,
        { to_user_id: user._id || user.id },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const convId = res.data?.conversation_id;
      if (convId) {
        const msgRes = await axios.get(`${BACKEND_URL}/api/chat/${convId}/messages`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        });
        setMessages(msgRes.data?.messages || []);
        setActiveConv({ id: convId, other_user: user });
        // AMENDMENT 4: mark as read immediately on open
        markConversationRead(convId);
        prevMessagesLength.current = msgRes.data?.messages?.length || 0;
      }
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.detail || 'Could not open chat');
    }
  };

  // Close chat and refresh conversations so new unread counts are accurate
  const closeChat = () => {
    setActiveConv(null);
    loadConversations();
  };

  const sendDirectMessage = async () => {
    if (!selectedUser || !messageContent.trim()) {
      Alert.alert('Error', 'Please select a user and enter a message');
      return;
    }
    setSending(true);
    try {
      const token = await getAuthToken();
      if (!token) return;
      await axios.post(
        `${BACKEND_URL}/api/admin/message`,
        { to_user_id: selectedUser._id || selectedUser.id, content: messageContent.trim() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      Alert.alert('✅ Sent', `Message delivered to ${selectedUser.full_name}`);
      setMessageContent('');
      setSelectedUser(null);
      setShowCompose(false);
      loadConversations();
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.detail || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const sendChatMsg = async () => {
    if (!chatMsg.trim() || !activeConv) return;
    setChatSending(true);
    try {
      const token = await getAuthToken();
      if (!token) return;
      await axios.post(`${BACKEND_URL}/api/chat/send`,
        { to_user_id: activeConv.other_user._id || activeConv.other_user.id, content: chatMsg.trim(), message_type: 'text' },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      setChatMsg('');
      const res = await axios.get(`${BACKEND_URL}/api/chat/${activeConv.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      });
      setMessages(res.data?.messages || []);
    } catch (_) {}
    finally { setChatSending(false); }
  };

  // ── AMENDMENT 4: Auto-scroll to bottom when new messages arrive ─────────────
  useEffect(() => {
    if (messages.length > prevMessagesLength.current) {
      prevMessagesLength.current = messages.length;
      // Small delay ensures the list has rendered before scrolling
      setTimeout(() => {
        chatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  const fmtTime = (iso: string) => {
    try {
      const d = new Date(iso); const now = new Date(); const diff = now.getTime() - d.getTime();
      if (diff < 86400000) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      if (diff < 604800000) return d.toLocaleDateString('en-US', { weekday: 'short' });
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return ''; }
  };

  // ── AMENDMENT 4: Make phone call ────────────────────────────────────────────
  const makePhoneCall = (phone: string) => {
    if (!phone) {
      Alert.alert('No Phone', 'This user has no phone number registered.');
      return;
    }
    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    const telUrl = `tel:${cleanPhone}`;
    Linking.canOpenURL(telUrl).then(supported => {
      if (supported) {
        Linking.openURL(telUrl);
      } else {
        Alert.alert('Error', 'Phone calls are not supported on this device.');
      }
    }).catch(() => {
      Alert.alert('Error', 'Failed to initiate phone call.');
    });
  };

  // ── Chat view ─────────────────────────────────────────────────────────────
  if (activeConv) {
    return (
      <SafeAreaView style={st.container}>
        <View style={st.chatHeader}>
          {/* AMENDMENT 4: back button calls closeChat so conversations refresh */}
          <TouchableOpacity onPress={closeChat} style={{ padding: 4 }}>
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={st.chatName}>{activeConv.other_user?.full_name || activeConv.other_user?.email || 'User'}</Text>
            <Text style={st.chatSub}>{activeConv.other_user?.role === 'security' ? '🛡 Security' : '🙋 Civilian'}</Text>
          </View>
          {/* AMENDMENT 4: Call button */}
          <TouchableOpacity onPress={() => makePhoneCall(activeConv.other_user?.phone)} style={{ marginRight: 8, padding: 4 }}>
            <Ionicons name="call" size={22} color="#10B981" />
          </TouchableOpacity>
          <TouchableOpacity onPress={async () => {
            const token = await getAuthToken();
            if (!token) return;
            const res = await axios.get(`${BACKEND_URL}/api/chat/${activeConv.id}/messages`, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
            setMessages(res.data?.messages || []);
          }}>
            <Ionicons name="refresh" size={22} color="#8B5CF6" />
          </TouchableOpacity>
        </View>
        <FlatList
          ref={chatListRef}
          data={messages}
          keyExtractor={item => item.id}
          contentContainerStyle={st.msgList}
          onContentSizeChange={() => chatListRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => (
            <View style={[st.bubble, item.is_mine ? st.mine : st.theirs]}>
              <Text style={[st.bubbleText, item.is_mine && { color: '#fff' }]}>{item.content}</Text>
              <Text style={[st.bubbleTime, item.is_mine && { color: '#ffffff70' }]}>{fmtTime(item.created_at)}</Text>
            </View>
          )}
        />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={st.inputRow}>
            <TextInput style={st.chatInput} placeholder="Type a message…" placeholderTextColor="#64748B" value={chatMsg} onChangeText={setChatMsg} multiline />
            <TouchableOpacity style={[st.sendBtn, !chatMsg.trim() && st.sendBtnOff]} onPress={sendChatMsg} disabled={!chatMsg.trim() || chatSending}>
              {chatSending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={20} color="#fff" />}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={st.container}>
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.replace('/admin/dashboard')}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={st.title}>Admin Messaging</Text>
        <TouchableOpacity onPress={() => setShowCompose(true)}>
          <Ionicons name="create-outline" size={26} color="#8B5CF6" />
        </TouchableOpacity>
      </View>

      {/* Tabs — AMENDMENT 4: conversations tab shows total unread badge */}
      <View style={st.tabs}>
        {(['search', 'conversations'] as Tab[]).map(t => (
          <TouchableOpacity key={t} style={[st.tab, tab === t && st.tabActive]} onPress={() => setTab(t)}>
            <View style={{ position: 'relative' }}>
              <Ionicons name={t === 'search' ? 'search' : 'chatbubbles'} size={18} color={tab === t ? '#8B5CF6' : '#64748B'} />
              {t === 'conversations' && totalUnread > 0 && (
                <View style={st.tabBadge}>
                  <Text style={st.tabBadgeText}>{totalUnread > 99 ? '99+' : totalUnread}</Text>
                </View>
              )}
            </View>
            <Text style={[st.tabText, tab === t && { color: '#8B5CF6' }]}>
              {t === 'search' ? 'Find User' : 'Conversations'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'search' ? (
        <View style={{ flex: 1 }}>
          <View style={st.searchBox}>
            <Ionicons name="search" size={20} color={searching ? '#8B5CF6' : '#64748B'} />
            <TextInput
              style={st.searchInput}
              placeholder="Search by name, email or phone…"
              placeholderTextColor="#64748B"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => { setSearchQuery(''); setSearchResults(filterUsers(allUsers, '', roleFilter)); }}>
                <Ionicons name="close-circle" size={20} color="#64748B" />
              </TouchableOpacity>
            )}
          </View>

          <View style={st.pills}>
            {(['all', 'civil', 'security'] as const).map(r => (
              <TouchableOpacity
                key={r}
                style={[st.pill, roleFilter === r && st.pillActive]}
                onPress={() => setRoleFilter(r)}
              >
                <Text style={[st.pillText, roleFilter === r && { color: '#8B5CF6' }]}>
                  {r === 'all' ? 'All' : r === 'civil' ? '🙋 Civil' : '🛡 Security'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={st.resultCount}>{searchResults.length} user{searchResults.length !== 1 ? 's' : ''} found</Text>

          <FlatList
            data={searchResults}
            keyExtractor={item => item._id || item.id}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
            ListEmptyComponent={
              <View style={st.empty}>
                <Ionicons name="people-outline" size={52} color="#334155" />
                <Text style={st.emptyText}>No users match your search</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={st.userCard}>
                <View style={[st.userAvatar, { backgroundColor: item.role === 'security' ? '#F59E0B20' : '#10B98120' }]}>
                  <Ionicons name={item.role === 'security' ? 'shield' : 'person'} size={22} color={item.role === 'security' ? '#F59E0B' : '#10B981'} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={st.userName}>{item.full_name || 'No name'}</Text>
                  <Text style={st.userEmail}>{item.email}</Text>
                  {item.phone && <Text style={st.userPhone}>📞 {item.phone}</Text>}
                  <Text style={st.userRoleBadge}>{item.role === 'security' ? '🛡 Security' : '🙋 Civilian'}</Text>
                </View>
                {/* AMENDMENT 4: Add call button */}
                {item.phone && (
                  <TouchableOpacity style={st.callBtn} onPress={() => makePhoneCall(item.phone)}>
                    <Ionicons name="call" size={18} color="#10B981" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={st.chatBtn} onPress={() => openChatWithUser(item)}>
                  <Ionicons name="chatbubble-ellipses" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={item => item.id}
          contentContainerStyle={st.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5CF6" />}
          ListEmptyComponent={
            <View style={st.empty}>
              <Ionicons name="chatbubbles-outline" size={60} color="#334155" />
              <Text style={st.emptyText}>No conversations yet</Text>
              <Text style={st.emptySub}>Search for a user to start a chat</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={st.convCard} onPress={() => openChatWithUser(item.other_user || item)}>
              <View style={[st.userAvatar, {
                backgroundColor: item.other_user?.role === 'security' ? '#F59E0B20' : '#10B98120'
              }]}>
                {item.other_user?.profile_photo_url ? (
                  <Image
                    source={{ uri: item.other_user.profile_photo_url.startsWith('http') ? item.other_user.profile_photo_url : `${BACKEND_URL}${item.other_user.profile_photo_url}` }}
                    style={[st.userAvatar, { width: 46, height: 46, borderRadius: 23 }]}
                  />
                ) : (
                  <Ionicons
                    name={item.other_user?.role === 'security' ? 'shield' : 'person'}
                    size={22}
                    color={item.other_user?.role === 'security' ? '#F59E0B' : '#10B981'}
                  />
                )}
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={st.userName}>{item.other_user?.full_name || 'Unknown'}</Text>
                <Text style={st.userEmail} numberOfLines={1}>
                  {item.other_user?.role === 'security' ? '🛡 Security' : '🙋 Civilian'}
                  {item.other_user?.email ? `  ·  ${item.other_user.email}` : ''}
                </Text>
                {/* AMENDMENT 4: preview text is bold when there are unread messages */}
                <Text
                  style={[st.convPrev, item.unread_count > 0 && st.convPrevUnread]}
                  numberOfLines={1}
                >
                  {item.last_message || 'No messages yet'}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={st.convTime}>{fmtTime(item.last_message_at)}</Text>
                {/* AMENDMENT 4: unread badge — disappears once read */}
                {item.unread_count > 0 && (
                  <View style={st.unread}>
                    <Text style={st.unreadText}>{item.unread_count}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Compose modal */}
      <Modal visible={showCompose} animationType="slide" transparent>
        <View style={st.modalOverlay}>
          <View style={st.modalBox}>
            <View style={st.modalHeader}>
              <Text style={st.modalTitle}>Send Direct Message</Text>
              <TouchableOpacity onPress={() => { setShowCompose(false); setSelectedUser(null); setMessageContent(''); }}>
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>
            </View>

            {!selectedUser ? (
              <>
                <Text style={st.modalLabel}>Select Recipient (search by name, email or phone)</Text>
                <TextInput
                  style={st.searchInput}
                  placeholder="Type to search…"
                  placeholderTextColor="#64748B"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoCapitalize="none"
                  autoFocus
                />
                <FlatList
                  data={searchResults.slice(0, 10)}
                  keyExtractor={item => item._id || item.id}
                  style={{ maxHeight: 260 }}
                  renderItem={({ item }) => {
                    const photoUrl = item.profile_photo_url
                      ? (item.profile_photo_url.startsWith('http')
                        ? item.profile_photo_url
                        : `${BACKEND_URL}${item.profile_photo_url}`)
                      : '';
                    return (
                      <TouchableOpacity style={st.userCard} onPress={() => setSelectedUser(item)}>
                        <View style={[st.userAvatar, { backgroundColor: item.role === 'security' ? '#F59E0B20' : '#10B98120' }]}>
                          {photoUrl ? (
                            <Image source={{ uri: photoUrl }} style={{ width: 40, height: 40, borderRadius: 20 }} />
                          ) : (
                            <Ionicons name={item.role === 'security' ? 'shield' : 'person'} size={20} color={item.role === 'security' ? '#F59E0B' : '#10B981'} />
                          )}
                        </View>
                        <View style={{ flex: 1, marginLeft: 10 }}>
                          <Text style={st.userName}>{item.full_name}</Text>
                          <Text style={st.userEmail}>{item.email}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  }}
                />
              </>
            ) : (
              <>
                <TouchableOpacity style={st.selectedUser} onPress={() => setSelectedUser(null)}>
                  {(() => {
                    const photoUrl = selectedUser.profile_photo_url
                      ? (selectedUser.profile_photo_url.startsWith('http')
                        ? selectedUser.profile_photo_url
                        : `${BACKEND_URL}${selectedUser.profile_photo_url}`)
                      : '';
                    return (
                      <View style={st.selectedAvatar}>
                        {photoUrl ? (
                          <Image source={{ uri: photoUrl }} style={{ width: 36, height: 36, borderRadius: 18 }} />
                        ) : (
                          <Ionicons name="person-circle" size={36} color="#8B5CF6" />
                        )}
                      </View>
                    );
                  })()}
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={st.userName}>{selectedUser.full_name}</Text>
                    <Text style={st.userEmail}>{selectedUser.email}</Text>
                  </View>
                  <Ionicons name="close-circle" size={20} color="#64748B" />
                </TouchableOpacity>
                <Text style={st.modalLabel}>Message</Text>
                <TextInput
                  style={st.msgInput}
                  placeholder="Type your message…"
                  placeholderTextColor="#64748B"
                  value={messageContent}
                  onChangeText={setMessageContent}
                  multiline
                  numberOfLines={5}
                  autoFocus
                />
                <TouchableOpacity
                  style={[st.sendButton, (!messageContent.trim()) && st.sendButtonOff]}
                  onPress={sendDirectMessage}
                  disabled={!messageContent.trim() || sending}
                >
                  {sending ? <ActivityIndicator size="small" color="#fff" /> : (
                    <><Ionicons name="send" size={20} color="#fff" /><Text style={st.sendButtonText}>Send Message</Text></>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  title: { fontSize: 20, fontWeight: '600', color: '#fff' },
  tabs: { flexDirection: 'row', padding: 12, gap: 8 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: '#1E293B' },
  tabActive: { borderWidth: 1, borderColor: '#8B5CF630' },
  tabText: { fontSize: 14, fontWeight: '500', color: '#64748B' },
  // AMENDMENT 4 — tab unread badge
  tabBadge: { position: 'absolute', top: -6, right: -8, backgroundColor: '#EF4444', borderRadius: 8, minWidth: 16, height: 16, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3, borderWidth: 1.5, borderColor: '#1E293B' },
  tabBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  searchBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 12, paddingHorizontal: 16, marginHorizontal: 16, marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  searchInput: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 14, marginLeft: 10 },
  pills: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1E293B', borderWidth: 1, borderColor: '#334155' },
  pillActive: { borderColor: '#8B5CF6', backgroundColor: '#8B5CF610' },
  pillText: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  resultCount: { fontSize: 12, color: '#475569', paddingHorizontal: 16, marginBottom: 8 },
  list: { padding: 16 },
  userCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 14, padding: 14, marginBottom: 10 },
  userAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#8B5CF620', justifyContent: 'center', alignItems: 'center' },
  userName: { fontSize: 15, fontWeight: '600', color: '#fff' },
  userEmail: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  userPhone: { fontSize: 12, color: '#10B981', marginTop: 1 },
  userRoleBadge: { fontSize: 11, color: '#64748B', marginTop: 2 },
  // AMENDMENT 4: call button style
  callBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#10B98120', justifyContent: 'center', alignItems: 'center', marginRight: 8 },
  chatBtn: { backgroundColor: '#8B5CF6', width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
  convCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 14, padding: 14, marginBottom: 10 },
  convPrev: { fontSize: 13, color: '#94A3B8', marginTop: 2 },
  convPrevUnread: { color: '#fff', fontWeight: '600' },   // bold when unread
  convTime: { fontSize: 11, color: '#64748B' },
  unread: { backgroundColor: '#8B5CF6', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, marginTop: 4 },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyText: { fontSize: 17, color: '#475569', marginTop: 16, fontWeight: '500' },
  emptySub: { fontSize: 13, color: '#334155', marginTop: 4 },
  chatHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  chatName: { fontSize: 17, fontWeight: '600', color: '#fff' },
  chatSub: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  msgList: { padding: 16, paddingBottom: 8 },
  bubble: { maxWidth: '80%', padding: 12, borderRadius: 16, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#8B5CF6', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#1E293B', borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 15, color: '#E2E8F0', lineHeight: 20 },
  bubbleTime: { fontSize: 10, color: '#64748B', marginTop: 4, textAlign: 'right' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, borderTopWidth: 1, borderTopColor: '#1E293B', gap: 10 },
  chatInput: { flex: 1, backgroundColor: '#1E293B', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, color: '#fff', fontSize: 15, maxHeight: 100 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#8B5CF6', justifyContent: 'center', alignItems: 'center' },
  sendBtnOff: { backgroundColor: '#334155' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  modalBox: { backgroundColor: '#1E293B', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 20, fontWeight: '600', color: '#fff' },
  modalLabel: { fontSize: 14, fontWeight: '500', color: '#94A3B8', marginBottom: 8, marginTop: 12 },
  selectedUser: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderRadius: 12, padding: 12, marginBottom: 4, borderWidth: 1, borderColor: '#8B5CF6' },
  selectedAvatar: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  msgInput: { backgroundColor: '#0F172A', borderRadius: 12, padding: 14, color: '#fff', fontSize: 15, minHeight: 100, textAlignVertical: 'top', marginBottom: 4 },
  sendButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#8B5CF6', paddingVertical: 14, borderRadius: 12, marginTop: 12 },
  sendButtonOff: { backgroundColor: '#334155' },
  sendButtonText: { fontSize: 16, fontWeight: '600', color: '#fff' },
});