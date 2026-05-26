import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, Alert,
  ActivityIndicator, Switch, Animated, Dimensions,
  Modal, KeyboardAvoidingView, Platform
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Camera, CameraView } from 'expo-camera';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import axios from 'axios';
import NetInfo from '@react-native-community/netinfo';
import Slider from '@react-native-community/slider';
import { getAuthToken } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';
import { addToQueue } from '../../utils/offlineQueue';
import { setRecordingAudioMode, restorePlaybackAudioMode } from '../../utils/AudioManager';

const MIN_RECORDING_DURATION = 2;
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function VideoReport() {
  const router = useRouter();
  const [hasPermission,    setHasPermission]    = useState<boolean | null>(null);
  const [isRecording,      setIsRecording]      = useState(false);
  const [caption,          setCaption]          = useState('');
  const [isAnonymous,      setIsAnonymous]      = useState(false);
  const [loading,          setLoading]          = useState(false);
  const [uploadProgress,   setUploadProgress]   = useState(0);
  const cameraRef = useRef<any>(null);
  const [recordingUri,     setRecordingUri]     = useState<string | null>(null);
  const [location,         setLocation]         = useState<any>(null);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [recordingDuration,  setRecordingDuration]  = useState(0);
  const [savedDuration,    setSavedDuration]    = useState(0);
  const [cameraReady,      setCameraReady]      = useState(false);
  const [showCaptionModal, setShowCaptionModal] = useState(false);
  const [zoom,             setZoom]             = useState(0);
  const [facing,           setFacing]           = useState<'back' | 'front'>('back');
  const [isOnline,         setIsOnline]         = useState(true);

  // KEY FIX: only mount CameraView when this screen is focused
  const [cameraActive, setCameraActive] = useState(false);

  // Restores the shared audio session to playback defaults.
  // CameraView.recordAsync() acquires the mic/audio session; without this call
  // after recording ends (or when the screen blurs), allowsRecordingIOS stays
  // true and bleeds into other screens (alarm, panic sounds, etc.).
  // FIX: Uses centralized AudioManager helper for consistent behavior.
  const restoreAudioMode = useCallback(() => {
    restorePlaybackAudioMode();
  }, []);

  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => {
        setCameraActive(false);
        setCameraReady(false);
        // Restore audio session whenever this screen loses focus —
        // covers back-navigation, tab-switch, and screen-stack changes.
        restoreAudioMode();
      };
    }, [restoreAudioMode])
  );

  const recordingPromiseRef  = useRef<Promise<any> | null>(null);
  const pulseAnim            = useRef(new Animated.Value(1)).current;
  const durationRef          = useRef(0);
  const actualStartTimeRef   = useRef<number>(0);
  const intervalRef          = useRef<any>(null);

  useEffect(() => {
    if (isRecording) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.3, duration: 500, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,   duration: 500, useNativeDriver: true }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [isRecording]);

  useEffect(() => {
    if (isRecording && recordingStartTime) {
      intervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        setRecordingDuration(elapsed);
        durationRef.current = elapsed;
      }, 100);
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isRecording, recordingStartTime]);

  useEffect(() => {
    requestPermissions();
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOnline(state.isConnected ?? true);
    });
    return () => unsubscribe();
  }, []);

  const requestPermissions = async () => {
    try {
      const { status: cameraStatus }  = await Camera.requestCameraPermissionsAsync();
      const { status: micStatus }     = await Camera.requestMicrophonePermissionsAsync();
      const { status: locationStatus } = await Location.requestForegroundPermissionsAsync();
      setHasPermission(cameraStatus === 'granted' && micStatus === 'granted');
      if (locationStatus === 'granted') {
        try {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          setLocation(loc);
        } catch (_) {}
      }
    } catch (_) {
      setHasPermission(false);
    }
  };

  const handleBack = async () => {
    if (isRecording) {
      try {
        if (cameraRef.current) await cameraRef.current.stopRecording();
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    restoreAudioMode();
    router.back();
  };

  const startRecording = async () => {
    if (!cameraRef.current || !cameraReady) {
      Alert.alert('Please Wait', 'Camera is still initializing…');
      return;
    }
    if (!location) {
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        .then(loc => setLocation(loc))
        .catch(() => {});
    }

    durationRef.current = 0;
    setRecordingDuration(0);
    setSavedDuration(0);
    setRecordingUri(null);

    const startTime = Date.now();
    actualStartTimeRef.current = startTime;
    setIsRecording(true);
    setRecordingStartTime(startTime);

    try {
      recordingPromiseRef.current = cameraRef.current.recordAsync({
        maxDuration: 120,
        quality: '480p',
        mute: false,
      });

      const video = await recordingPromiseRef.current;

      const endTime            = Date.now();
      const calculatedDuration = Math.floor((endTime - actualStartTimeRef.current) / 1000);
      const finalDuration      = Math.max(calculatedDuration, durationRef.current, 2);

      if (video && video.uri) {
        setRecordingUri(video.uri);
        setSavedDuration(finalDuration);
        setShowCaptionModal(true);
      } else {
        throw new Error('No video URI returned from camera');
      }
    } catch (error: any) {
      if (!error?.message?.toLowerCase().includes('stopped')) {
        Alert.alert('Recording Error', error?.message || 'Failed to record video.');
      }
    } finally {
      setIsRecording(false);
      setRecordingStartTime(null);
      recordingPromiseRef.current = null;
      actualStartTimeRef.current  = 0;
      // Restore audio session — CameraView held the mic; release it now.
      restoreAudioMode();
    }
  };

  const stopRecording = async () => {
    if (!isRecording) return;
    if (durationRef.current < MIN_RECORDING_DURATION) {
      Alert.alert('Recording Too Short', `Please record for at least ${MIN_RECORDING_DURATION} seconds.`);
      return;
    }
    try {
      if (cameraRef.current) await cameraRef.current.stopRecording();
    } catch (_) {}
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const onCameraReady = () => {
    setTimeout(() => setCameraReady(true), 800);
  };

  /**
   * Camera flip — continues recording through the lens switch.
   *
   * expo-camera's native recording session stays alive when the `facing` prop
   * changes; only the active lens is swapped. We update the state directly so
   * the prop reaches CameraView while recordAsync() is still pending in
   * startRecording(). The resulting video file contains both pre- and
   * post-flip footage in a single continuous clip.
   *
   * The previous implementation called stopRecording() before flipping,
   * which is what caused the recording to end on every camera switch.
   */
  const toggleFacing = () => {
    setFacing(c => c === 'back' ? 'front' : 'back');
  };

  const saveReportLocally = async (loc: any, duration: number) => {
    try {
      // FIX: was using || 0 fallback — silently queueing reports with 0,0 coords
      // when location was missing. Now we preserve null so the queue can reject
      // or flag them. The caller (submitReport) already ensures loc is non-null.
      await addToQueue({
        type: 'video', localUri: recordingUri!,
        caption: caption || 'Live security report',
        isAnonymous,
        latitude:  loc?.coords?.latitude  ?? 0,
        longitude: loc?.coords?.longitude ?? 0,
        duration_seconds: duration,
        timestamp: new Date().toISOString(),
      });
      Alert.alert('📥 Saved Locally', 'Will upload automatically when you reconnect.',
        [{ text: 'OK', onPress: () => router.back() }]);
    } catch (_) {
      Alert.alert('Error', 'Failed to save report locally');
    }
  };

  const submitReport = async () => {
    if (!recordingUri) { 
      Alert.alert('Error', 'Please record a video first'); 
      return; 
    }
    
    const finalDuration = savedDuration;
    if (finalDuration < MIN_RECORDING_DURATION) {
      Alert.alert('Invalid Duration', `Video too short (${finalDuration}s). Re-record for at least ${MIN_RECORDING_DURATION}s.`,
        [{ text: 'Re-record', onPress: () => setShowCaptionModal(false) }, { text: 'Cancel', style: 'cancel' }]);
      return;
    }

    setShowCaptionModal(false);
    setLoading(true);
    setUploadProgress(0);

    let currentLocation = location;
    if (!currentLocation) {
      try {
        currentLocation = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        setLocation(currentLocation);
      } catch (_) {
        Alert.alert('Location Required', 'Unable to get your location. Report cannot be submitted without location.', [{ text: 'OK' }]);
        setLoading(false);
        return;
      }
    }

    if (!isOnline) {
      setLoading(false);
      Alert.alert('Offline', 'You are currently offline. Save locally?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save Locally', onPress: () => saveReportLocally(currentLocation, finalDuration) }
      ]);
      return;
    }

    try {
      const token = await getAuthToken();
      if (!token) { 
        router.replace('/auth/login'); 
        return; 
      }

      const xhr = new XMLHttpRequest();
      
      const uploadPromise = new Promise((resolve, reject) => {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(Math.min(percentComplete, 95));
          }
        });
        
        xhr.addEventListener('load', () => {
          if (xhr.status === 200) {
            try {
              const response = JSON.parse(xhr.responseText);
              resolve(response);
            } catch (e) {
              reject(new Error('Invalid response'));
            }
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        });
        
        xhr.addEventListener('error', () => {
          reject(new Error('Network error during upload'));
        });
        
        xhr.addEventListener('timeout', () => {
          reject(new Error('Upload timeout'));
        });
        
        const body = new FormData();
        body.append('video', { 
          uri: recordingUri, 
          type: 'video/mp4', 
          name: `video_report_${Date.now()}.mp4` 
        } as any);
        body.append('caption', caption || 'Live security report');
        body.append('is_anonymous', String(isAnonymous));
        body.append('latitude', String(currentLocation.coords.latitude));
        body.append('longitude', String(currentLocation.coords.longitude));
        body.append('duration_seconds', String(finalDuration));
        
        xhr.open('POST', `${BACKEND_URL}/api/report/upload-video`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.timeout = 180000;
        
        xhr.send(body);
      });
      
      await uploadPromise as any;
      
      setUploadProgress(100);
      
      Alert.alert('Success!', 'Your video report has been uploaded successfully.',
        [{ text: 'OK', onPress: () => router.back() }]);
        
    } catch (error: any) {
      console.error('[VideoReport] Upload error:', error);
      
      let msg = 'Failed to upload report.';
      if (error.message?.includes('timeout')) {
        msg = 'Upload timed out. The video may be too large.';
      } else if (error.message?.includes('Network')) {
        msg = 'Network error. Please check your connection.';
      }
      
      Alert.alert('Upload Issue', `${msg}\n\nSave locally to upload later?`, [
        { text: 'Discard', style: 'destructive' },
        { text: 'Save Locally', onPress: () => saveReportLocally(currentLocation, finalDuration) }
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (hasPermission === null) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#10B981" />
          <Text style={styles.loadingText}>Requesting permissions...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (hasPermission === false) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={80} color="#EF4444" />
          <Text style={styles.errorText}>Camera & Microphone access required</Text>
          <TouchableOpacity style={styles.retryButton} onPress={requestPermissions}>
            <Text style={styles.retryButtonText}>Grant Permissions</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.fullScreenContainer}>

      {/* Camera surface — only mounted while screen is focused */}
      {cameraActive && (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFillObject}
          facing={facing}
          mode="video"
          zoom={zoom}
          onCameraReady={onCameraReady}
        />
      )}

      {/* Top overlay: back / recording indicator / flip
          AMENDMENT 1: flip button is always enabled (no disabled={isRecording}).
          Tapping during recording gracefully stops the segment then flips. */}
      <SafeAreaView style={styles.topOverlay} pointerEvents="box-none">
        <TouchableOpacity style={styles.iconBtn} onPress={handleBack}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>

        {isRecording && (
          <View style={styles.recordingIndicator}>
            <Animated.View style={[styles.recordingDot, { transform: [{ scale: pulseAnim }] }]} />
            <Text style={styles.recordingTime}>{formatDuration(recordingDuration)}</Text>
          </View>
        )}

        {/* Camera-flip is now always tappable */}
        <TouchableOpacity style={styles.iconBtn} onPress={toggleFacing}>
          <Ionicons name="camera-reverse" size={28} color="#fff" />
        </TouchableOpacity>
      </SafeAreaView>

      {/* Status badges */}
      {!isOnline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline" size={18} color="#F59E0B" />
          <Text style={styles.offlineText}>Offline — reports will be saved locally</Text>
        </View>
      )}

      {location && (
        <View style={styles.locationBadge}>
          <Ionicons name="location" size={14} color="#10B981" />
          <Text style={styles.locationText}>
            GPS: {location.coords.latitude.toFixed(4)}, {location.coords.longitude.toFixed(4)}
          </Text>
        </View>
      )}

      {recordingUri && !isRecording && savedDuration > 0 && (
        <View style={styles.recordedBadge}>
          <Ionicons name="checkmark-circle" size={20} color="#10B981" />
          <Text style={styles.recordedText}>Recorded: {formatDuration(savedDuration)}</Text>
        </View>
      )}

      {/* AMENDMENT 1: Zoom slider is ALWAYS visible — during and outside recording.
          Zoom changes are applied live via the CameraView `zoom` prop without
          interrupting an ongoing recording. */}
      <View style={styles.zoomContainer}>
        <Text style={styles.zoomLabel}>Zoom: {Math.round(zoom * 100)}%</Text>
        <Slider
          style={styles.zoomSlider}
          minimumValue={0}
          maximumValue={1}
          step={0.01}
          value={zoom}
          onValueChange={setZoom}
          minimumTrackTintColor="#10B981"
          maximumTrackTintColor="#ffffff50"
          thumbTintColor="#10B981"
        />
      </View>

      {/* Bottom controls */}
      <View style={styles.bottomOverlay}>
        <View style={styles.controlsRow}>
          <View style={styles.sideButton} />

          <TouchableOpacity
            style={[styles.recordButton, isRecording && styles.recordButtonActive]}
            onPress={isRecording ? stopRecording : startRecording}
            disabled={loading || !cameraReady}
          >
            <View style={[styles.recordButtonInner, isRecording && styles.recordButtonInnerActive]}>
              {isRecording
                ? <Ionicons name="stop" size={32} color="#fff" />
                : <View style={styles.recordButtonCircle} />
              }
            </View>
          </TouchableOpacity>

          {recordingUri && !isRecording && savedDuration > 0 ? (
            <TouchableOpacity style={styles.uploadButton} onPress={() => setShowCaptionModal(true)}>
              <Ionicons name="cloud-upload" size={28} color="#fff" />
            </TouchableOpacity>
          ) : (
            <View style={styles.sideButton} />
          )}
        </View>

        <Text style={styles.instructionText}>
          {!cameraReady          ? 'Initializing camera…' :
           isRecording           ? `Recording… ${formatDuration(recordingDuration)}` :
           recordingUri && savedDuration > 0 ? `Ready to upload (${formatDuration(savedDuration)})` :
           'Tap record to start'}
        </Text>
      </View>

      {/* Upload progress overlay */}
      {loading && (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingCard}>
            <ActivityIndicator size="large" color="#10B981" />
            <Text style={styles.loadingTitle}>
              {uploadProgress < 30 ? 'Preparing…' :
               uploadProgress < 70 ? 'Uploading…' :
               uploadProgress < 95 ? 'Processing…' :
               'Finalising…'}
            </Text>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${uploadProgress}%` as any }]} />
            </View>
            <Text style={styles.progressText}>{uploadProgress}%</Text>
          </View>
        </View>
      )}

      {/* Caption modal */}
      <Modal visible={showCaptionModal} animationType="slide" transparent>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Details</Text>
              <TouchableOpacity onPress={() => setShowCaptionModal(false)}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            <View style={styles.durationDisplay}>
              <Ionicons name="time" size={20} color="#10B981" />
              <Text style={styles.durationText}>Duration: {formatDuration(savedDuration)}</Text>
            </View>

            <Text style={styles.inputLabel}>Caption (Optional)</Text>
            <TextInput
              style={styles.captionInput}
              value={caption}
              onChangeText={setCaption}
              placeholder="Describe the situation..."
              placeholderTextColor="#64748B"
              multiline
              numberOfLines={3}
            />

            <View style={styles.toggleRow}>
              <View>
                <Text style={styles.toggleLabel}>Submit Anonymously</Text>
                <Text style={styles.toggleDescription}>Your identity will be hidden</Text>
              </View>
              <Switch
                value={isAnonymous}
                onValueChange={setIsAnonymous}
                trackColor={{ false: '#334155', true: '#10B98150' }}
                thumbColor={isAnonymous ? '#10B981' : '#94A3B8'}
              />
            </View>

            <TouchableOpacity style={styles.submitButton} onPress={submitReport}>
              <Ionicons name="cloud-upload" size={24} color="#fff" />
              <Text style={styles.submitButtonText}>{isOnline ? 'Upload Report' : 'Save Locally'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container:              { flex: 1, backgroundColor: '#0F172A' },
  fullScreenContainer:    { flex: 1, backgroundColor: '#000' },
  loadingContainer:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText:            { color: '#94A3B8', marginTop: 16 },
  errorContainer:         { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorText:              { color: '#EF4444', fontSize: 18, marginTop: 16, textAlign: 'center' },
  retryButton:            { marginTop: 20, backgroundColor: '#3B82F6', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  retryButtonText:        { color: '#fff', fontWeight: '600' },

  topOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16,
  },
  iconBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center', alignItems: 'center',
  },
  recordingIndicator: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
  },
  recordingDot:  { width: 12, height: 12, borderRadius: 6, backgroundColor: '#EF4444', marginRight: 8 },
  recordingTime: { color: '#fff', fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] as any },

  offlineBanner: {
    position: 'absolute', top: Platform.OS === 'ios' ? 100 : 80, alignSelf: 'center', zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(245,158,11,0.9)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
  },
  offlineText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  locationBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 100 : 80, alignSelf: 'center', zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(16,185,129,0.9)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
  },
  locationText: { color: '#fff', fontSize: 11, fontWeight: '600' },

  recordedBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 140 : 120, alignSelf: 'center', zIndex: 10,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(16,185,129,0.9)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
  },
  recordedText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // AMENDMENT 1: zoom container is always positioned at the bottom area,
  // visible both during and outside recording.
  zoomContainer: {
    position: 'absolute', bottom: Platform.OS === 'ios' ? 190 : 170, left: 20, right: 20, zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, padding: 12,
  },
  zoomLabel:  { color: '#fff', fontSize: 14, marginBottom: 8, textAlign: 'center' },
  zoomSlider: { width: '100%', height: 40 },

  bottomOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  controlsRow:            { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 40 },
  sideButton:             { width: 60 },
  recordButton:           { width: 80, height: 80, borderRadius: 40, borderWidth: 4, borderColor: '#fff', justifyContent: 'center', alignItems: 'center', backgroundColor: 'transparent' },
  recordButtonActive:     { borderColor: '#EF4444' },
  recordButtonInner:      { width: 64, height: 64, borderRadius: 32, backgroundColor: '#EF4444', justifyContent: 'center', alignItems: 'center' },
  recordButtonInnerActive:{ backgroundColor: '#EF4444', borderRadius: 8 },
  recordButtonCircle:     { width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff' },
  uploadButton:           { width: 60, height: 60, borderRadius: 30, backgroundColor: '#10B981', justifyContent: 'center', alignItems: 'center' },
  instructionText:        { color: '#fff', textAlign: 'center', marginTop: 16, fontSize: 14, opacity: 0.85 },

  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', zIndex: 20 },
  loadingCard:    { backgroundColor: '#1E293B', borderRadius: 16, padding: 32, alignItems: 'center', width: 280 },
  loadingTitle:   { color: '#fff', fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 20 },
  progressBar:    { width: '100%', height: 8, backgroundColor: '#334155', borderRadius: 4, overflow: 'hidden' },
  progressFill:   { height: '100%', backgroundColor: '#10B981' },
  progressText:   { color: '#94A3B8', marginTop: 8 },

  modalOverlay:       { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent:       { backgroundColor: '#1E293B', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  modalHeader:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle:         { fontSize: 20, fontWeight: '600', color: '#fff' },
  durationDisplay:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#10B98120', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, marginBottom: 16, alignSelf: 'flex-start' },
  durationText:       { fontSize: 15, fontWeight: '600', color: '#10B981' },
  inputLabel:         { color: '#94A3B8', marginBottom: 8, fontSize: 14 },
  captionInput:       { backgroundColor: '#0F172A', borderRadius: 12, padding: 16, color: '#fff', minHeight: 100, textAlignVertical: 'top', marginBottom: 20 },
  toggleRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0F172A', padding: 16, borderRadius: 12, marginBottom: 20 },
  toggleLabel:        { color: '#fff', fontWeight: '500' },
  toggleDescription:  { color: '#64748B', fontSize: 12, marginTop: 2 },
  submitButton:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#10B981', paddingVertical: 16, borderRadius: 12 },
  submitButtonText:   { color: '#fff', fontSize: 16, fontWeight: '600' },
});
