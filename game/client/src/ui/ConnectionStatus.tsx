import React from 'react';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

interface ConnectionStatusProps {
  status: ConnectionState;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({ status }) => {
  const statusText = {
    connecting: '🔄 Connecting...',
    connected: '✅ Connected',
    disconnected: '❌ Disconnected'
  };

  return (
    <div className={`connection-status ${status}`}>
      {statusText[status]}
    </div>
  );
};

