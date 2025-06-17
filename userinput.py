#!/usr/bin/env python3
"""
User Input Script for AR Toy Project
Main workflow implementation as specified in rules.md
"""

def main():
    """
    Main workflow loop:
    1. Read user input
    2. Process tasks based on input
    3. Repeat until user enters "stop"
    """
    print("🎛️ AR Toy Project - User Input System")
    print("Following main workflow from rules.md")
    print("Enter your tasks/requests below. Type 'stop' to exit.")
    print("-" * 50)
    
    while True:
        try:
            # Read user input
            user_input = input("\n📝 Enter your request: ").strip()
            
            # Exit condition
            if user_input.lower() == "stop":
                print("🛑 Exiting workflow loop as requested.")
                break
            
            # Skip empty inputs
            if not user_input:
                continue
                
            # Process the input
            print(f"\n✅ Received: {user_input}")
            print("📋 Task logged for processing...")
            
            # Log the task (this would be processed by the assistant)
            with open("user_tasks.log", "a") as f:
                f.write(f"{user_input}\n")
            
            print("💡 Task has been recorded for the assistant to process.")
            print("   The assistant will handle this request in the next iteration.")
            
        except KeyboardInterrupt:
            print("\n\n🛑 Interrupted by user. Exiting...")
            break
        except Exception as e:
            print(f"❌ Error: {e}")
            continue

if __name__ == "__main__":
    main() 