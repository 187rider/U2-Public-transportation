from PIL import Image

def create_padded_icon(source_path, dest_path, size):
    # Open the source image
    img = Image.open(source_path).convert("RGBA")
    
    # Calculate target dimensions (leave 10% padding on each side)
    max_size = int(size * 0.8)
    
    # Resize preserving aspect ratio
    img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    
    # Create a new white image of the target size
    background = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    
    # Calculate position to center the image
    x = (size - img.width) // 2
    y = (size - img.height) // 2
    
    # Paste using the image itself as a mask to preserve transparency of the coat of arms edges
    background.paste(img, (x, y), img)
    
    # Convert back to RGB to remove alpha channel completely (safer for some devices)
    background = background.convert("RGB")
    background.save(dest_path, "PNG")

if __name__ == "__main__":
    source = "/Users/damdinsambilov/Downloads/ulan-ude-map/web/public/ulan_ude.gif"
    create_padded_icon(source, "/Users/damdinsambilov/Downloads/ulan-ude-map/web/public/icon-512.png", 512)
    create_padded_icon(source, "/Users/damdinsambilov/Downloads/ulan-ude-map/web/public/apple-touch-icon.png", 192)
    print("Icons successfully created with padding and white background!")
