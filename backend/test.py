import socket

IP = "10.106.89.35"
PORT = 3030

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect((IP, PORT))

print("✅ Connected to printer")

# 🔥 Try sending basic commands
try:
    sock.send(b'\x00\x00\x00\x00')   # test packet
    data = sock.recv(4096)
    print("DATA:", data)

except Exception as e:
    print("Error:", e)

sock.close()