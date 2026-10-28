from Xlib import X, display, Xatom
import json

d = display.Display()
root = d.screen().root

# Intern XINTENT Atoms
ATOM_CONTROL = d.intern_atom('_XINTENT_CONTROL')
ATOM_REQUEST = d.intern_atom('_XINTENT_REQUEST')
ATOM_RESPONSE = d.intern_atom('_XINTENT_RESPONSE')
ATOM_STRING = d.intern_atom('UTF8_STRING')

# Create off-screen window for receiving intent messages
win = root.create_window(0, 0, 1, 1, 0, X.CopyFromParent)

# Register window in global root property
root.change_property(ATOM_CONTROL, Xatom.WINDOW, 32, [win.id], mode=X.PropModeAppend)
d.sync()

print(f"[XINTENT] Listening on Window ID: {hex(win.id)}")

while True:
    event = d.next_event()
    
    # Handle incoming ClientMessage interrupts
    if event.type == X.ClientMessage and event.data.l[0] == ATOM_REQUEST:
        sender_win_id = event.data.l[1]
        
        # Read payload from our window property
        prop = win.get_full_property(ATOM_REQUEST, ATOM_STRING)
        if prop:
            request_data = json.loads(prop.value.decode('utf-8'))
            print(f"[XINTENT] Processing text: {request_data.get('text')}")
            
            # ... Generate TTS audio to /tmp/cool_tts_out.wav ...
            
            response_payload = json.dumps({
                "status": "ok", 
                "path": "/tmp/cool_tts_out.wav"
            }).encode('utf-8')
            
            # Write response back to window property and notify sender
            win.change_property(ATOM_RESPONSE, ATOM_STRING, 8, response_payload)
            
            reply_event = Xevent.ClientMessage(
                window=d.create_resource_object('window', sender_win_id),
                client_type=ATOM_RESPONSE,
                data=(32, [ATOM_RESPONSE, win.id, 0, 0, 0])
            )
            d.send_event(sender_win_id, reply_event)
            d.flush()