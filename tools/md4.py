import struct
def _rol(x,n): x&=0xffffffff; return ((x<<n)|(x>>(32-n)))&0xffffffff
def md4(data: bytes) -> bytes:
    msg=bytearray(data); l=len(msg)*8; msg.append(0x80)
    while len(msg)%64!=56: msg.append(0)
    msg+=struct.pack('<Q',l)
    a,b,c,d=0x67452301,0xefcdab89,0x98badcfe,0x10325476
    F=lambda x,y,z:(x&y)|(~x&z); G=lambda x,y,z:(x&y)|(x&z)|(y&z); H=lambda x,y,z:x^y^z
    for i in range(0,len(msg),64):
        X=struct.unpack('<16I',msg[i:i+64]); aa,bb,cc,dd=a,b,c,d
        for k,s in zip(range(16),[3,7,11,19]*4):
            t=[a,b,c,d]; a=_rol(a+F(b,c,d)+X[k],s); a,b,c,d=d,a,b,c
        for k,s in zip([0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15],[3,5,9,13]*4):
            a=_rol(a+G(b,c,d)+X[k]+0x5a827999,s); a,b,c,d=d,a,b,c
        for k,s in zip([0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15],[3,9,11,15]*4):
            a=_rol(a+H(b,c,d)+X[k]+0x6ed9eba1,s); a,b,c,d=d,a,b,c
        a=(a+aa)&0xffffffff;b=(b+bb)&0xffffffff;c=(c+cc)&0xffffffff;d=(d+dd)&0xffffffff
    return struct.pack('<4I',a,b,c,d)
if __name__=='__main__':
    assert md4(b'').hex()=='31d6cfe0d16ae931b73c59d7e0c089c0', md4(b'').hex()
    assert md4(b'abc').hex()=='a448017aaf21d8525fc10ae87aa6729d'
    print('md4 ok')
