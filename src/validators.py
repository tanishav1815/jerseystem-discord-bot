import re

# RFC 5322 simplified email regex pattern
EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")

def is_valid_email(email: str | None) -> bool:
    """
    Validates email format, domain structure, and TLD.
    """
    if not email:
        return False
    
    cleaned = email.strip()
    if len(cleaned) < 5 or len(cleaned) > 254:
        return False
        
    if not EMAIL_REGEX.match(cleaned):
        return False
        
    parts = cleaned.split('@')
    if len(parts) != 2:
        return False
        
    domain = parts[1]
    # Check domain dots
    if '.' not in domain or domain.startswith('.') or domain.endswith('.'):
        return False
    if '..' in domain:
        return False
        
    # Check top-level domain (TLD) length (e.g. .com, .org, .edu, .io)
    tld = domain.split('.')[-1]
    if len(tld) < 2 or not tld.isalpha():
        return False
        
    return True

def sanitize_email(email: str) -> str:
    """
    Trims leading/trailing whitespace and converts to lowercase.
    """
    return email.strip().lower()
