import { createContext } from 'react';
// openFile(path), openSession(id)
export const ChatCtx = createContext({ openFile: () => {}, openSession: () => {} });
