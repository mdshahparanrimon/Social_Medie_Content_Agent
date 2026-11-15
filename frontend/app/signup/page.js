import AuthRedirect from '@/components/AuthRedirect';

// Sign-up is a popup now; this keeps old links working.
export default function SignupPage() {
  return <AuthRedirect mode="signup" />;
}
