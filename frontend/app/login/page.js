import AuthRedirect from '@/components/AuthRedirect';

// Sign-in is a popup now; this keeps old links working.
export default function LoginPage() {
  return <AuthRedirect mode="login" />;
}
