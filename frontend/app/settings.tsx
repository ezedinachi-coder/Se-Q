import React, { useState, useEffect, useRef } from 'react';
import AsyncStorage from '../utils/asyncStorageShim';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, Image, Modal, Switch } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../utils/auth';
import BACKEND_URL from '../utils/config';

interface EmergencyContact {
  name: string;
  phone: string;
  email: string;
}

export default function Settings() {
  const router = useRouter();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>([
    { name: '', phone: '', email: '' },
    { name: '', phone: '', email: '' }
  ]);
  const [savingContacts, setSavingContacts] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [messageSoundEnabled, setMessageSoundEnabled] = useState(true);
  const cameraRef = React.useRef<CameraView>(null);

  useEffect(() => {
    initializeSettings();
  }, []);

  const initializeSettings = async () => {
    setPageLoading(true);
    const token = await getAuthToken();
    if (!token) {
      router.replace('/auth/login');
      return;
    }

    // Load message sound preference
    try {
      const soundEnabled = await AsyncStorage.getItem('msg_sound_enabled');
      setMessageSoundEnabled(soundEnabled !== 'false'); // Default ON
    } catch (_) {}

    await loadProfile();
    setPageLoading(false);
  };

  const toggleMessageSound = async (value: boolean) => {
    setMessageSoundEnabled(value);
    await AsyncStorage.setItem('msg_sound_enabled', value ? 'true' : 'false');
    Alert.alert(
      value ? 'Sound Enabled' : 'Sound Disabled',
      value ? 'You will hear a sound for new messages.' : 'Message sound alerts are now off.'
    );
  };

  const loadProfile = async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      const response = await axios.get(`${BACKEND_URL}/api/user/profile`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      console.log('[Settings] Profile loaded');
      setUserProfile(response.data);
      if (response.data.profile_photo_url) {
        const photoUrl = response.data.profile_photo_url;
        setProfilePhoto(photoUrl.startsWith('http') ? photoUrl : `${BACKEND_URL}${photoUrl}`);
      }
      if (response.data.emergency_contacts && response.data.emergency_contacts.length > 0) {
        const contacts = [...response.data.emergency_contacts];
        while (contacts.length < 2) {
          contacts.push({ name: '', phone: '', email: '' });
        }
        setEmergencyContacts(contacts);
      }
    } catch (error: any) {
      console.error('[Settings] Failed to load profile:', error?.response?.status);
      if (error?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      }
    }
  };

  const pickAndUploadPhoto = async () => {
    Alert.alert('Update Profile Photo', 'Choose photo source:', [
      {
        text: 'Camera',
        onPress: async () => {
          if (!cameraPermission?.granted) {
            const result = await requestCameraPermission();
            if (!result.granted) {
              Alert.alert('Permission Required', 'Camera permission is needed.');
              return;
            }
          }
          setShowCamera(true);
        },
      },
      {
        text: 'Photo Library',
        onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') {
            Alert.alert('Permission Required', 'Photo library access is needed to pick a photo.');
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'] as any,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.7,
          });
          if (!result.canceled && result.assets[0]?.uri) {
            const asset = result.assets[0];
            const mime = asset.mimeType && asset.mimeType.startsWith('image/')
              ? asset.mimeType
              : 'image/jpeg';
            await uploadPhotoUri(asset.uri, mime);
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const uploadPhotoUri = async (uri: string, mimeType: string = 'image/jpeg') => {
    setUploadingPhoto(true);
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      let base64: string;
      if (Platform.OS === 'web') {
        // Web: fetch as blob and convert to base64
        const resp = await fetch(uri);
        const blob = await resp.blob();
        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1] || dataUrl);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } else {
        // Mobile: Use legacy API from expo-file-system/legacy
        // This is the recommended migration path for expo-file-system v55+
        // The legacy API provides readAsStringAsync which is not available in the new API
        const FS = require('expo-file-system/legacy');
        base64 = await FS.readAsStringAsync(uri, {
          encoding: FS.EncodingType.Base64,
        });
      }

      // Use JSON body with base64 - avoids multipart issues on web/mobile
      const response = await axios.post(
        `${BACKEND_URL}/api/user/profile-photo-base64`,
        {
          photo_base64: base64,
          mime_type: mimeType,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      const photoUrl = response.data.photo_url;
      setProfilePhoto(photoUrl.startsWith('http') ? photoUrl : `${BACKEND_URL}${photoUrl}`);
      Alert.alert('Success', 'Profile photo updated! Security agents can now identify you.');
    } catch (error: any) {
      const status = (error as any)?.response?.status;
      const msg = (error as any)?.response?.data?.detail || (error as any)?.message || 'Failed to upload photo.';
      Alert.alert('Upload Failed', `${msg}${status ? ' ('+status+')' : ''}`);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const captureAndUpload = async () => {
    if (!cameraRef.current) {
      Alert.alert('Error', 'Camera not ready. Please try again.');
      return;
    }
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
      setShowCamera(false);
      if (!photo?.uri) { Alert.alert('Error', 'Could not capture photo'); return; }
      await uploadPhotoUri(photo.uri, 'image/jpeg');
    } catch (error: any) {
      setShowCamera(false);
      Alert.alert('Camera Error', error?.message || 'Failed to take photo. Please try again.');
    }
  };

  const updateEmergencyContact = (index: number, field: keyof EmergencyContact, value: string) => {
    const newContacts = [...emergencyContacts];
    newContacts[index] = { ...newContacts[index], [field]: value };
    setEmergencyContacts(newContacts);
  };

  const saveEmergencyContacts = async () => {
    const validContacts = emergencyContacts.filter(c => c.phone.trim() !== '');
    if (validContacts.length === 0) {
      Alert.alert('Error', 'Please add at least one emergency contact with phone number');
      return;
    }
    setSavingContacts(true);
    try {
      const token = await getAuthToken();
      if (!token) {
        router.replace('/auth/login');
        return;
      }
      await axios.put(`${BACKEND_URL}/api/user/emergency-contacts`, {
        contacts: emergencyContacts.filter(c => c.phone.trim() !== '')
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      Alert.alert('Success', 'Emergency contacts saved. They will be notified during panic events.');
    } catch (error: any) {
      console.error('[Settings] Save contacts error:', error?.response?.data);
      Alert.alert('Error', 'Failed to save emergency contacts');
    } finally {
      setSavingContacts(false);
    }
  };

  if (pageLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3B82F6" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Settings</Text>
          <View style={{ width: 24 }} />
        </View>
        <ScrollView style={styles.content}>
          {/* Profile Photo Upload Section - TOP OF PAGE */}
          <View style={styles.profilePhotoSection}>
            <Text style={styles.profilePhotoTitle}>Profile Photo</Text>
            <Text style={styles.profilePhotoSubtitle}>Upload a photo so security agents can identify you</Text>
            <TouchableOpacity style={styles.profilePhotoButton} onPress={pickAndUploadPhoto} disabled={uploadingPhoto}>
              {profilePhoto ? (
                <Image source={{ uri: profilePhoto }} style={styles.profilePhotoImage} />
              ) : (
                <View style={styles.profilePhotoPlaceholder}>
                  <Ionicons name="person" size={48} color="#3B82F6" />
                </View>
              )}
              <View style={styles.profilePhotoUploadBadge}>
                {uploadingPhoto ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="camera" size={16} color="#fff" />
                )}
              </View>
            </TouchableOpacity>
            <Text style={styles.profilePhotoHint}>
              {profilePhoto ? 'Tap to change photo' : 'Tap to upload photo'}
            </Text>
          </View>

          {/* User Profile Section */}
          {userProfile && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Your Profile</Text>
              <View style={styles.profileCard}>
                <View style={styles.profileInfo}>
                  <Text style={styles.profileName}>{userProfile.full_name || 'User'}</Text>
                  <Text style={styles.profileEmail}>{userProfile.email}</Text>
                  {userProfile.phone && (
                    <Text style={styles.profilePhone}>{userProfile.phone}</Text>
                  )}
                  <View style={[styles.premiumBadge, userProfile.is_premium ? styles.premiumActive : styles.premiumInactive]}>
                    <Text style={styles.premiumText}>
                      {userProfile.is_premium ? '⭐ Premium' : 'Free Plan'}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* Emergency Contacts Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Emergency Contacts</Text>
            <Text style={styles.sectionDescription}>These contacts will be notified via SMS during panic events</Text>
            {emergencyContacts.map((contact, index) => (
              <View key={index} style={styles.contactCard}>
                <Text style={styles.contactHeader}>Contact {index + 1}</Text>
                <Text style={styles.inputLabel}>Name</Text>
                <TextInput
                  style={styles.input}
                  value={contact.name}
                  onChangeText={(v) => updateEmergencyContact(index, 'name', v)}
                  placeholder="Contact name"
                  placeholderTextColor="#64748B"
                />
                <Text style={styles.inputLabel}>Phone Number *</Text>
                <TextInput
                  style={styles.input}
                  value={contact.phone}
                  onChangeText={(v) => updateEmergencyContact(index, 'phone', v)}
                  placeholder="Phone number"
                  placeholderTextColor="#64748B"
                  keyboardType="phone-pad"
                />
                <Text style={styles.inputLabel}>Email (Optional)</Text>
                <TextInput
                  style={styles.input}
                  value={contact.email}
                  onChangeText={(v) => updateEmergencyContact(index, 'email', v)}
                  placeholder="Email address"
                  placeholderTextColor="#64748B"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            ))}
            <View style={styles.smsPreview}>
              <Text style={styles.smsPreviewTitle}>📱 SMS Preview:</Text>
              <Text style={styles.smsPreviewText}>
                Hello {emergencyContacts[0]?.name || '[Contact Name]'}, Kindly reach-out to your {userProfile?.full_name || '[User Name]'} - {userProfile?.phone || '[User Phone]'} who has activated a Panic Emergency. Thanks{"\n\n"}- Se-Q Securities
              </Text>
            </View>
            <TouchableOpacity style={styles.saveContactsButton} onPress={saveEmergencyContacts} disabled={savingContacts}>
              {savingContacts ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="people" size={20} color="#fff" />
                  <Text style={styles.saveButtonText}>Save Emergency Contacts</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Quick Emergency Numbers */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Emergency Services</Text>
            <View style={styles.emergencyServicesCard}>
              <View style={styles.emergencyService}>
                <View style={[styles.serviceIcon, { backgroundColor: '#EF444420' }]}>
                  <Ionicons name="call" size={24} color="#EF4444" />
                </View>
                <View style={styles.serviceInfo}>
                  <Text style={styles.serviceName}>Police / Emergency</Text>
                  <Text style={styles.serviceNumber}>911 / 112</Text>
                </View>
              </View>
              <View style={styles.emergencyService}>
                <View style={[styles.serviceIcon, { backgroundColor: '#10B98120' }]}>
                  <Ionicons name="medkit" size={24} color="#10B981" />
                </View>
                <View style={styles.serviceInfo}>
                  <Text style={styles.serviceName}>Medical Emergency</Text>
                  <Text style={styles.serviceNumber}>112</Text>
                </View>
              </View>
              <View style={styles.emergencyService}>
                <View style={[styles.serviceIcon, { backgroundColor: '#F59E0B20' }]}>
                  <Ionicons name="flame" size={24} color="#F59E0B" />
                </View>
                <View style={styles.serviceInfo}>
                  <Text style={styles.serviceName}>Fire Service</Text>
                  <Text style={styles.serviceNumber}>101</Text>
                </View>
              </View>
            </View>
          </View>

          {/* Notifications Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notifications</Text>
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Message Sound</Text>
                <Text style={styles.settingDescription}>Play a sound when you receive new messages</Text>
              </View>
              <Switch
                value={messageSoundEnabled}
                onValueChange={toggleMessageSound}
                trackColor={{ false: '#334155', true: '#3B82F6' }}
                thumbColor="#fff"
              />
            </View>
          </View>

          {/* About Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About</Text>
            <View style={styles.aboutCard}>
              <Ionicons name="shield-checkmark" size={48} color="#3B82F6" />
              <Text style={styles.aboutTitle}>Se-Q</Text>
              <Text style={styles.aboutVersion}>Version 1.0.0</Text>
              <Text style={styles.aboutDescription}>Your personal safety companion</Text>
            </View>
          </View>
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Camera Modal */}
      <Modal visible={showCamera} animationType="slide" onRequestClose={() => setShowCamera(false)}>
        <View style={styles.cameraModal}>
          <CameraView ref={cameraRef} style={styles.cameraView} facing="front">
            <View style={styles.cameraOverlay}>
              <View style={styles.cameraHeader}>
                <TouchableOpacity onPress={() => setShowCamera(false)} style={styles.cameraCancelBtn}>
                  <Ionicons name="close" size={28} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.cameraTitle}>Take Profile Photo</Text>
                <View style={{ width: 44 }} />
              </View>
              <View style={styles.cameraGuide}>
                <View style={styles.cameraFaceFrame} />
                <Text style={styles.cameraGuideText}>Position your face in the circle</Text>
              </View>
              <View style={styles.cameraBottom}>
                <TouchableOpacity style={styles.captureBtn} onPress={captureAndUpload}>
                  <View style={styles.captureBtnInner} />
                </TouchableOpacity>
              </View>
            </View>
          </CameraView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  content: { flex: 1, padding: 16 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: '#fff', marginBottom: 8 },
  sectionDescription: { fontSize: 14, color: '#64748B', marginBottom: 16 },
  profileCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20, flexDirection: 'row', alignItems: 'center' },
  profileAvatar: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 18, fontWeight: '600', color: '#fff', marginBottom: 4 },
  profileEmail: { fontSize: 14, color: '#94A3B8', marginBottom: 2 },
  profilePhone: { fontSize: 14, color: '#64748B', marginBottom: 8 },
  premiumBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, alignSelf: 'flex-start' },
  premiumActive: { backgroundColor: '#F59E0B20' },
  premiumInactive: { backgroundColor: '#64748B20' },
  premiumText: { fontSize: 12, fontWeight: '600', color: '#F59E0B' },
  inputLabel: { fontSize: 14, color: '#94A3B8', marginBottom: 8, marginTop: 16 },
  input: { backgroundColor: '#0F172A', borderRadius: 12, padding: 16, color: '#fff', fontSize: 16 },
  saveButtonText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  contactCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20, marginBottom: 16 },
  contactHeader: { fontSize: 16, fontWeight: '600', color: '#3B82F6', marginBottom: 8 },
  smsPreview: { backgroundColor: '#1E293B', borderRadius: 12, padding: 16, marginBottom: 16 },
  smsPreviewTitle: { fontSize: 14, fontWeight: '600', color: '#fff', marginBottom: 8 },
  smsPreviewText: { fontSize: 13, color: '#94A3B8', lineHeight: 20 },
  saveContactsButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#10B981', paddingVertical: 14, borderRadius: 12 },
  emergencyServicesCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 16 },
  emergencyService: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#334155' },
  serviceIcon: { width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  serviceInfo: { flex: 1 },
  serviceName: { fontSize: 16, fontWeight: '500', color: '#fff', marginBottom: 2 },
  serviceNumber: { fontSize: 14, color: '#64748B' },
  aboutCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 24, alignItems: 'center' },
  aboutTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginTop: 12 },
  aboutVersion: { fontSize: 14, color: '#64748B', marginTop: 4 },
  aboutDescription: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginTop: 8 },
  profileAvatarImage: { width: 70, height: 70, borderRadius: 35 },
  photoEditBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#3B82F6', borderRadius: 10, width: 20, height: 20, justifyContent: 'center', alignItems: 'center' },
  // Camera modal
  cameraModal: { flex: 1, backgroundColor: '#000' },
  cameraView: { flex: 1 },
  cameraOverlay: { flex: 1, justifyContent: 'space-between' },
  cameraHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 60, backgroundColor: 'rgba(0,0,0,0.4)' },
  cameraCancelBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  cameraTitle: { fontSize: 18, fontWeight: '600', color: '#fff' },
  cameraGuide: { alignItems: 'center' },
  cameraFaceFrame: { width: 220, height: 220, borderRadius: 110, borderWidth: 3, borderColor: 'rgba(255,255,255,0.7)', borderStyle: 'dashed' },
  cameraGuideText: { color: 'rgba(255,255,255,0.8)', marginTop: 16, fontSize: 14 },
  cameraBottom: { alignItems: 'center', paddingBottom: 60, backgroundColor: 'rgba(0,0,0,0.4)' },
  captureBtn: { width: 80, height: 80, borderRadius: 40, borderWidth: 4, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  captureBtnInner: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff' },
  // Profile Photo Section - TOP OF PAGE
  profilePhotoSection: { alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 20, padding: 24, marginBottom: 24 },
  profilePhotoTitle: { fontSize: 20, fontWeight: '600', color: '#fff', marginBottom: 8 },
  profilePhotoSubtitle: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginBottom: 20 },
  profilePhotoButton: { width: 120, height: 120, borderRadius: 60, overflow: 'hidden', position: 'relative' },
  profilePhotoImage: { width: 120, height: 120, borderRadius: 60 },
  profilePhotoPlaceholder: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#3B82F6', borderStyle: 'dashed' },
  profilePhotoUploadBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#3B82F6', borderRadius: 16, width: 32, height: 32, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#1E293B' },
  profilePhotoHint: { fontSize: 14, color: '#64748B', marginTop: 12 },
  // Settings row
  settingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1E293B', padding: 16, borderRadius: 12, marginBottom: 12 },
  settingInfo: { flex: 1, marginRight: 16 },
  settingLabel: { fontSize: 16, color: '#fff', fontWeight: '500' },
  settingDescription: { fontSize: 13, color: '#64748B', marginTop: 4 },
});
