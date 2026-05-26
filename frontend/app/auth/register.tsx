import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert, ActivityIndicator, Animated, StatusBar, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { saveAuthData } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';

export default function Register() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('civil');
  const [inviteCode, setInviteCode] = useState('');
  const [securitySubRole, setSecuritySubRole] = useState('team_member');
  const [teamName, setTeamName] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);

  // Animation states
  const [fadeAnim] = useState(new Animated.Value(0));
  const [slideAnim] = useState(new Animated.Value(50));
  const [stepIndicator] = useState(new Animated.Value(0));

  // Theme colors based on role
  const themeColors = {
    civil: {
      primary: '#10B981',      // Green
      primaryLight: 'rgba(16, 185, 129, 0.1)',
      primaryDark: '#059669',
      accent: '#34D399',
      iconColor: '#10B981',
      inputBorder: 'rgba(16, 185, 129, 0.3)',
      inputIconBg: 'rgba(16, 185, 129, 0.1)',
      roleCardActive: 'rgba(16, 185, 129, 0.15)',
      roleIconActive: 'rgba(16, 185, 129, 0.2)',
    },
    security: {
      primary: '#F59E0B',     // Amber
      primaryLight: 'rgba(245, 158, 11, 0.1)',
      primaryDark: '#D97706',
      accent: '#FBBF24',
      iconColor: '#F59E0B',
      inputBorder: 'rgba(245, 158, 11, 0.3)',
      inputIconBg: 'rgba(245, 158, 11, 0.1)',
      roleCardActive: 'rgba(245, 158, 11, 0.15)',
      roleIconActive: 'rgba(245, 158, 11, 0.2)',
    }
  };

  const currentTheme = themeColors[role as 'civil' | 'security'];

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  const validateEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleRegister = async () => {
    if (!email || !password || !confirmPassword) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }
    if (!validateEmail(email.trim())) {
      Alert.alert('Error', 'Please enter a valid email address');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }
    if (role === 'security' && !inviteCode) {
      Alert.alert('Error', 'Security users require an invite code');
      return;
    }

    setLoading(true);
    try {
      const response = await axios.post(`${BACKEND_URL}/api/auth/register`, {
        email: email.trim().toLowerCase(),
        phone: phone.trim() || null,
        full_name: fullName.trim() || null,
        password,
        confirm_password: confirmPassword,
        role,
        invite_code: inviteCode.trim().toUpperCase() || null,
        security_sub_role: role === 'security' ? securitySubRole : null,
        team_name: role === 'security' ? teamName.trim() : null,
      }, { timeout: 15000 });

      await saveAuthData({
        token: response.data.token,
        user_id: String(response.data.user_id),
        role: response.data.role,
        is_premium: response.data.is_premium,
      });

      Alert.alert('Welcome!', 'Your account has been created successfully.', [
        {
          text: 'Continue',
          onPress: () => {
            if (response.data.role === 'security') {
              router.replace('/security/home');
            } else {
              router.replace('/civil/home');
            }
          }
        }
      ]);
    } catch (error: any) {
      let errorMessage = 'An unexpected error occurred';
      if (error.response) {
        errorMessage = error.response.data?.detail ||
                       error.response.data?.message ||
                       'Registration failed. Please try again.';
      } else if (error.request) {
        errorMessage = 'Server is unreachable. Please check your internet connection.';
      } else if (error.code === 'ECONNABORTED') {
        errorMessage = 'Connection timed out. Please try again.';
      } else {
        errorMessage = error.message || 'Registration failed. Please try again.';
      }
      Alert.alert('Registration Failed', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const nextStep = () => {
    if (currentStep === 1 && !role) return;
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Background elements */}
      <View style={styles.gradientOverlay} />
      <View style={[styles.topRightGlow, { backgroundColor: currentTheme.primary }]} />
      <View style={[styles.bottomLeftGlow, { backgroundColor: currentTheme.primaryDark }]} />

      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardView}>
          <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>

            {/* Header Section */}
            <View style={styles.header}>
              <TouchableOpacity style={[styles.backButton, { backgroundColor: currentTheme.primaryLight }]} onPress={() => router.back()}>
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </TouchableOpacity>

              <View style={styles.logoSection}>
                <Image
                  source={require('../../assets/images/login-logo.png')}
                  style={styles.logoIcon}
                  resizeMode="contain"
                />
              </View>

              <Text style={styles.pageTitle}>Create Account</Text>
              <Text style={styles.pageSubtitle}>Join Se-Q and stay protected</Text>
            </View>

            {/* Progress Indicator */}
            <View style={styles.progressContainer}>
              {[1, 2, 3].map((step) => (
                <View key={step} style={styles.progressStep}>
                  <View style={[
                    styles.progressDot,
                    {
                      backgroundColor: currentStep >= step ? currentTheme.primary : 'rgba(99, 102, 241, 0.2)',
                      borderColor: currentStep >= step ? currentTheme.primary : 'rgba(99, 102, 241, 0.3)',
                    }
                  ]}>
                    {currentStep > step ? (
                      <Ionicons name="checkmark" size={12} color="#fff" />
                    ) : (
                      <Text style={styles.progressDotText}>{step}</Text>
                    )}
                  </View>
                  {step < 3 && (
                    <View style={[
                      styles.progressLine,
                      { backgroundColor: currentStep > step ? currentTheme.primary : 'rgba(99, 102, 241, 0.2)' }
                    ]} />
                  )}
                </View>
              ))}
            </View>

            <ScrollView
              style={styles.formScroll}
              contentContainerStyle={styles.formScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Step 1: Role Selection */}
              {currentStep === 1 && (
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>I am a:</Text>
                  <View style={styles.roleContainer}>
                    <TouchableOpacity
                      style={[styles.roleCard, role === 'civil' && {
                        backgroundColor: currentTheme.roleCardActive || 'rgba(16, 185, 129, 0.15)',
                        borderColor: currentTheme.primary
                      }]}
                      onPress={() => setRole('civil')}
                      activeOpacity={0.8}
                    >
                      <View style={[styles.roleIconContainer, {
                        backgroundColor: role === 'civil' ? currentTheme.roleIconActive : 'rgba(99, 102, 241, 0.1)'
                      }]}>
                        <Ionicons name="person" size={32} color={role === 'civil' ? currentTheme.primary : '#64748B'} />
                      </View>
                      <Text style={[styles.roleTitle, role === 'civil' && { color: '#fff' }]}>Civil User</Text>
                      <Text style={styles.roleDescription}>Personal safety and emergency response</Text>
                      {role === 'civil' && (
                        <View style={[styles.roleBadge, { backgroundColor: currentTheme.primary }]}>
                          <Text style={styles.roleBadgeText}>Green Theme</Text>
                        </View>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.roleCard, role === 'security' && {
                        backgroundColor: currentTheme.roleCardActive || 'rgba(245, 158, 11, 0.15)',
                        borderColor: currentTheme.primary
                      }]}
                      onPress={() => setRole('security')}
                      activeOpacity={0.8}
                    >
                      <View style={[styles.roleIconContainer, {
                        backgroundColor: role === 'security' ? currentTheme.roleIconActive : 'rgba(99, 102, 241, 0.1)'
                      }]}>
                        <Ionicons name="shield" size={32} color={role === 'security' ? currentTheme.primary : '#64748B'} />
                      </View>
                      <Text style={[styles.roleTitle, role === 'security' && { color: '#fff' }]}>Security Agency</Text>
                      <Text style={styles.roleDescription}>Professional security services</Text>
                      {role === 'security' && (
                        <View style={[styles.roleBadge, { backgroundColor: currentTheme.primary }]}>
                          <Text style={styles.roleBadgeText}>Amber Theme</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  </View>

                  {role === 'security' && (
                    <View style={styles.securityFields}>
                      <Text style={styles.stepTitle}>Your Role:</Text>
                      <View style={styles.subRoleContainer}>
                        <TouchableOpacity
                          style={[styles.subRoleCard, securitySubRole === 'supervisor' && styles.subRoleCardActive]}
                          onPress={() => setSecuritySubRole('supervisor')}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="star" size={24} color={securitySubRole === 'supervisor' ? currentTheme.primary : '#64748B'} />
                          <Text style={[styles.subRoleText, securitySubRole === 'supervisor' && { color: currentTheme.primary }]}>Supervisor</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.subRoleCard, securitySubRole === 'team_member' && styles.subRoleCardActive]}
                          onPress={() => setSecuritySubRole('team_member')}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="people" size={24} color={securitySubRole === 'team_member' ? currentTheme.primary : '#64748B'} />
                          <Text style={[styles.subRoleText, securitySubRole === 'team_member' && { color: currentTheme.primary }]}>Team Member</Text>
                        </TouchableOpacity>
                      </View>

                      <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                        <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                          <Ionicons name="key" size={20} color={currentTheme.iconColor} />
                        </View>
                        <TextInput
                          style={styles.input}
                          placeholder="Security Invite Code *"
                          placeholderTextColor="#64748B"
                          value={inviteCode}
                          onChangeText={setInviteCode}
                          autoCapitalize="characters"
                          autoCorrect={false}
                        />
                      </View>

                      <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                        <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                          <Ionicons name="business" size={20} color={currentTheme.iconColor} />
                        </View>
                        <TextInput
                          style={styles.input}
                          placeholder="Team Name (optional)"
                          placeholderTextColor="#64748B"
                          value={teamName}
                          onChangeText={setTeamName}
                        />
                      </View>
                    </View>
                  )}
                </View>
              )}

              {/* Step 2: Personal Info */}
              {currentStep === 2 && (
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>Personal Information</Text>

                  <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                    <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                      <Ionicons name="person" size={20} color={currentTheme.iconColor} />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Full Name"
                      placeholderTextColor="#64748B"
                      value={fullName}
                      onChangeText={setFullName}
                      autoCapitalize="words"
                    />
                  </View>

                  <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                    <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                      <Ionicons name="call" size={20} color={currentTheme.iconColor} />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Phone Number (optional)"
                      placeholderTextColor="#64748B"
                      value={phone}
                      onChangeText={setPhone}
                      keyboardType="phone-pad"
                    />
                  </View>
                </View>
              )}

              {/* Step 3: Account Credentials */}
              {currentStep === 3 && (
                <View style={styles.stepContent}>
                  <Text style={styles.stepTitle}>Account Details</Text>

                  <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                    <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                      <Ionicons name="mail" size={20} color={currentTheme.iconColor} />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Email Address *"
                      placeholderTextColor="#64748B"
                      value={email}
                      onChangeText={setEmail}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>

                  <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                    <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                      <Ionicons name="lock-closed" size={20} color={currentTheme.iconColor} />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Password *"
                      placeholderTextColor="#64748B"
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity
                      style={styles.eyeButton}
                      onPress={() => setShowPassword(!showPassword)}
                    >
                      <Ionicons
                        name={showPassword ? 'eye-off' : 'eye'}
                        size={20}
                        color="#64748B"
                      />
                    </TouchableOpacity>
                  </View>

                  <View style={[styles.inputContainer, { borderColor: currentTheme.inputBorder }]}>
                    <View style={[styles.inputIconContainer, { backgroundColor: currentTheme.inputIconBg, borderRightColor: currentTheme.inputBorder }]}>
                      <Ionicons name="lock-closed" size={20} color={currentTheme.iconColor} />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Confirm Password *"
                      placeholderTextColor="#64748B"
                      value={confirmPassword}
                      onChangeText={setConfirmPassword}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                </View>
              )}

              {/* Navigation Buttons */}
              <View style={styles.buttonContainer}>
                {currentStep > 1 && (
                  <TouchableOpacity
                    style={[styles.prevButton, { borderColor: currentTheme.inputBorder }]}
                    onPress={prevStep}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="arrow-back" size={20} color={currentTheme.iconColor} />
                    <Text style={[styles.prevButtonText, { color: currentTheme.iconColor }]}>Back</Text>
                  </TouchableOpacity>
                )}

                {currentStep < 3 ? (
                  <TouchableOpacity
                    style={[styles.nextButton, { backgroundColor: currentTheme.primary }]}
                    onPress={nextStep}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.nextButtonText}>Continue</Text>
                    <Ionicons name="arrow-forward" size={20} color="#fff" />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.registerButton, loading && styles.registerButtonDisabled, { backgroundColor: currentTheme.primary, shadowColor: currentTheme.primary }]}
                    onPress={handleRegister}
                    disabled={loading}
                    activeOpacity={0.8}
                  >
                    {loading ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <View style={styles.registerButtonContent}>
                        <Text style={styles.registerButtonText}>Create Account</Text>
                        <Ionicons name="checkmark-circle" size={20} color="#fff" />
                      </View>
                    )}
                  </TouchableOpacity>
                )}
              </View>

              {/* Login Link */}
              <View style={styles.loginSection}>
                <Text style={styles.loginText}>Already have an account? </Text>
                <TouchableOpacity onPress={() => router.replace('/auth/login')}>
                  <Text style={[styles.loginLink, { color: currentTheme.primary }]}>Sign In</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0E21',
  },
  gradientOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '100%',
    backgroundColor: '#0A0E21',
  },
  topRightGlow: {
    position: 'absolute',
    top: -150,
    right: -150,
    width: 400,
    height: 400,
    borderRadius: 200,
    opacity: 0.08,
  },
  bottomLeftGlow: {
    position: 'absolute',
    bottom: -100,
    left: -100,
    width: 300,
    height: 300,
    borderRadius: 150,
    opacity: 0.06,
  },
  safeArea: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
  },
  header: {
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 24,
  },
  backButton: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoSection: {
    marginBottom: 12,
  },
  logoIcon: {
    width: 156,
    height: 52,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 4,
  },
  pageSubtitle: {
    fontSize: 15,
    color: '#94A3B8',
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
    paddingHorizontal: 40,
  },
  progressStep: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  progressDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
  },
  progressDotText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  progressLine: {
    width: 60,
    height: 3,
    marginHorizontal: 8,
    borderRadius: 2,
  },
  formScroll: {
    flex: 1,
  },
  formScrollContent: {
    paddingBottom: 24,
  },
  stepContent: {
    marginBottom: 24,
  },
  stepTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 16,
  },
  roleContainer: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 24,
  },
  roleCard: {
    flex: 1,
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(99, 102, 241, 0.2)',
  },
  roleIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  roleTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#94A3B8',
    marginBottom: 4,
  },
  roleDescription: {
    fontSize: 12,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 16,
  },
  roleBadge: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
  },
  roleBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  securityFields: {
    marginTop: 8,
  },
  subRoleContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  subRoleCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: 'rgba(99, 102, 241, 0.2)',
  },
  subRoleCardActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: '#F59E0B',
  },
  subRoleText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748B',
  },
  subRoleTextActive: {
    color: '#F59E0B',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 16,
    overflow: 'hidden',
  },
  inputIconContainer: {
    width: 56,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRightWidth: 1,
  },
  input: {
    flex: 1,
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  eyeButton: {
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 8,
  },
  prevButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    borderRadius: 16,
    paddingVertical: 18,
    borderWidth: 1,
  },
  prevButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  nextButton: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    paddingVertical: 18,
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  registerButton: {
    flex: 2,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  registerButtonDisabled: {
    opacity: 0.7,
  },
  registerButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  registerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  loginSection: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
    paddingBottom: 32,
  },
  loginText: {
    color: '#94A3B8',
    fontSize: 15,
  },
  loginLink: {
    fontSize: 15,
    fontWeight: '600',
  },
});
