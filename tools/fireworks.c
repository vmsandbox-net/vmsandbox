#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <math.h>
#include <sys/ioctl.h>
#include <signal.h>

#define MAX_FIREWORKS 10
#define MAX_PARTICLES 40
#define DEFAULT_DURATION 7

typedef struct {
    float x, y, px, py;
    float vx, vy;
    int r, g, b;
    int active;
    float life;
} Particle;

typedef struct {
    Particle p[MAX_PARTICLES];
    int active, type; // 0: burst, 1: ring, 2: fountain
} Firework;

float wind = 0.04f; // Global horizontal drift

void reset_terminal(int sig) {
    printf("\033[0m\033[?25h\033[2J\033[H");
    exit(0);
}

void move_cursor(int x, int y) { printf("\033[%d;%dH", y, x); }
void set_color(int r, int g, int b) { printf("\033[38;2;%d;%d;%dm", r, g, b); }

void init_firework(Firework *f, int w, int h) {
    f->active = 1;
    f->type = rand() % 3;
    int start_x = rand() % (w - 20) + 10;
    int r = rand()%155+100, g = rand()%155+100, b = rand()%155+100;
    
    f->p[0] = (Particle){start_x, (float)h-1, start_x, (float)h-1, 
                         (rand()%10-5)/15.0f, -(rand()%(h/3) + (h/4))/5.0f, r, g, b, 1, 1.0f};
    for (int i = 1; i < MAX_PARTICLES; i++) f->p[i].active = 0;
}

void explode(Firework *f) {
    f->p[0].active = 0;
    for (int i = 1; i < MAX_PARTICLES; i++) {
        float angle = (rand() % 360) * M_PI / 180.0;
        float speed = (f->type == 1) ? 1.5f : ((rand() % 100) / 40.0f + 0.5f);
        f->p[i] = (Particle){f->p[0].x, f->p[0].y, f->p[0].x, f->p[0].y,
                             cos(angle)*speed*2.2f, sin(angle)*speed, f->p[0].r, 
                             f->p[0].g, f->p[0].b, 1, 1.0f};
    }
}

int main(int argc, char *argv[]) {
    int duration = DEFAULT_DURATION;
    if (argc >= 2) {
        duration = atoi(argv[1]);
        if (duration <= 0) duration = DEFAULT_DURATION;
    }

    signal(SIGINT, reset_terminal);
    struct winsize w;
    ioctl(STDOUT_FILENO, TIOCGWINSZ, &w);
    int width = w.ws_col, height = w.ws_row;

    srand(time(NULL));
    printf("\033[2J\033[?25l");

    Firework fireworks[MAX_FIREWORKS] = {0};
    time_t start_time = time(NULL);

    while (difftime(time(NULL), start_time) < duration) {
        for (int i = 0; i < MAX_FIREWORKS; i++) {
            if (!fireworks[i].active && rand() % 18 == 0) init_firework(&fireworks[i], width, height);
            if (!fireworks[i].active) continue;

            int visible = 0;
            for (int j = 0; j < MAX_PARTICLES; j++) {
                Particle *p = &fireworks[i].p[j];
                if (p->px > 0) { move_cursor((int)p->px, (int)p->py); printf(" "); }
                if (!p->active) continue;

                p->px = p->x; p->py = p->y;
                p->x += p->vx + wind; // Apply global wind
                p->y += p->vy;
                p->vx *= 0.96f; p->vy = (p->vy * 0.96f) + 0.07f; // Air resistance + Gravity
                p->life -= 0.022f;

                if (p->life <= 0 || p->y <= 2 || p->y >= height || p->x <= 1 || p->x >= width) {
                    p->active = 0;
                    if (j == 0) explode(&fireworks[i]);
                    continue;
                }

                visible = 1;
                move_cursor((int)p->x, (int)p->y);
                
                // Color transition: White-hot to base color
                float f = p->life;
                set_color(fmin(255, p->r + (1-f)*50), fmin(255, p->g + (1-f)*50), fmin(255, p->b + (1-f)*50));
                
                if (j == 0) printf("▲");
                else {
                    if (f > 0.8) printf("✺");
                    else if (f > 0.5) printf("❈");
                    else if (f > 0.3) printf("✱");
                    else printf("·");
                }
            }
            if (!visible) fireworks[i].active = 0;
        }
        fflush(stdout);
        usleep(45000);
    }
    reset_terminal(0);
    return 0;
}
